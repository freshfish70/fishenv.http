/** Fluent builder for WebSocket routes, layered on the core `RouteBuilder`. */

import {
  type AnySchema,
  BadRequestError,
  type BuildEnv,
  DEFAULT_MAX_PAYLOAD_LENGTH,
  type DIContainer,
  type FinishedRoute,
  HttpError,
  type InputOptions,
  type Logger,
  type MergeParam,
  type MiddlewareFn,
  type RouteBuilder,
  type RouteMeta,
  requestUpgrade,
  TooManyRequestsError,
} from "../core/index.ts";
import type { WsConnection } from "./connection.ts";
import {
  isWebSocketUpgrade,
  negotiateProtocol,
  UpgradeRequiredError,
} from "./helpers.ts";
import type { WsHub } from "./hub.ts";
import { createLifecycle } from "./lifecycle.ts";
import { ConnectionCounter, type WsConnectionLimit } from "./limits.ts";
import {
  createOriginPolicy,
  type OriginPolicy,
  type OriginSource,
  originSourcesFromCors,
} from "./origin.ts";
import {
  type WsCleanupFn,
  WsCloseCode,
  WsCloseError,
  type WsRateLimit,
} from "./types.ts";

export interface WsHandlerArgs<
  Ctx extends Record<string, unknown>,
  Params extends Record<string, unknown>,
> {
  socket: WsConnection;
  path: Params;
  ctx: Ctx;
  /** The upgrade request. */
  req: Request;
  container: DIContainer;
}

export type WsHandlerFn<
  Ctx extends Record<string, unknown>,
  Params extends Record<string, unknown>,
> = (
  args: WsHandlerArgs<Ctx, Params>,
) => void | WsCleanupFn | Promise<void | WsCleanupFn>;

/**
 * A reusable protocol implementation (channels, JSON-RPC, …) that plugs into
 * `.handleWith()` exactly like the built-in `channels()` handler.
 */
export interface WsProtocolHandler<
  Ctx extends Record<string, unknown>,
  Params extends Record<string, unknown>,
> {
  /** Subprotocols this handler speaks, in preference order. */
  readonly protocols?: readonly string[];
  readonly setup: WsHandlerFn<Ctx, Params>;
  /** Startup validation hook (e.g. completeness checks). */
  onBuild?(env: BuildEnv): void;
}

/** Router-level defaults set via `withWs(router, options)`. */
export interface WsRouterOptions {
  /** Origin sources added to every ws route on this router. */
  origins?: OriginSource[];
}

/** Mutable per-route configuration, copied when a builder is re-created. */
export interface WsRouteOptions {
  routerOrigins: OriginSource[];
  origins: OriginSource[];
  inheritOrigins: boolean;
  protocols?: readonly string[];
  maxMessageSize?: number;
  rateLimit?: WsRateLimit;
  maxQueuedMessages?: number;
  // biome-ignore lint/suspicious/noExplicitAny: args type is erased at runtime
  maxConnections?: WsConnectionLimit<any>;
}

type Inner<
  RouterCtx extends Record<string, unknown>,
  RouteCtx extends Record<string, unknown>,
  Params extends Record<string, unknown>,
> = RouteBuilder<
  RouterCtx,
  RouteCtx,
  "none",
  InputOptions<"none">,
  Params,
  undefined
>;

const ServiceUnavailable = () =>
  new HttpError(503, "Too many open connections");

/**
 * Delegates to the core `RouteBuilder`, so `.param()` / `.with()` carry
 * exactly the same generics as HTTP and SSE routes.
 *
 * Handshake order: origin → upgrade headers (426) → subprotocol →
 * middleware → path params → connection limits → upgrade.
 */
export class WsRouteBuilder<
  RouterCtx extends Record<string, unknown>,
  RouteCtx extends Record<string, unknown>,
  Params extends Record<string, unknown>,
> {
  readonly #inner: Inner<RouterCtx, RouteCtx, Params>;
  readonly #options: WsRouteOptions;

  constructor(
    inner: Inner<RouterCtx, RouteCtx, Params>,
    options: Partial<WsRouteOptions> = {},
  ) {
    this.#inner = inner;
    this.#options = {
      routerOrigins: [],
      origins: [],
      inheritOrigins: true,
      ...options,
    };
  }

  meta(data: RouteMeta): this {
    this.#inner.meta(data);
    return this;
  }

  /**
   * Add allowed origins on top of the inherited ones (root `cors()` and
   * `withWs()` options). Pass `{ inherit: false }` to replace them instead.
   */
  origin(
    ...args: [...OriginSource[], { inherit?: boolean }] | OriginSource[]
  ): this {
    const last = args.at(-1);
    let sources = args as OriginSource[];
    if (last != null && typeof last === "object" && !(last instanceof RegExp)) {
      sources = args.slice(0, -1) as OriginSource[];
      if ((last as { inherit?: boolean }).inherit === false) {
        this.#options.inheritOrigins = false;
      }
    }
    createOriginPolicy(sources); // validate eagerly: fail at definition time
    this.#options.origins.push(...sources);
    return this;
  }

  /** Supported subprotocols in preference order; others get `400`. */
  protocols(list: readonly string[]): this {
    if (list.length === 0) throw new Error("protocols(): list is empty");
    this.#options.protocols = [...list];
    return this;
  }

  /** Per-route inbound limit (closes with `1009`). Must be ≤ the server-wide limit. */
  maxMessageSize(bytes: number): this {
    if (!(bytes > 0)) throw new Error("maxMessageSize(): must be positive");
    this.#options.maxMessageSize = bytes;
    return this;
  }

  /** Inbound token bucket per connection. Opt-in. */
  rateLimit(limit: WsRateLimit): this {
    if (!(limit.messages > 0) || !(limit.perMs > 0)) {
      throw new Error("rateLimit(): messages and perMs must be positive");
    }
    this.#options.rateLimit = { ...limit };
    return this;
  }

  /** Cap open sockets on this route (`503`) and/or per key (`429`). */
  maxConnections(
    limit: WsConnectionLimit<
      Omit<WsHandlerArgs<RouterCtx & RouteCtx, Params>, "socket">
    >,
  ): this {
    this.#options.maxConnections = limit;
    return this;
  }

  param<Name extends string & keyof Params, S extends AnySchema>(
    name: Name,
    schema: S,
  ): WsRouteBuilder<RouterCtx, RouteCtx, MergeParam<Params, Name, S>> {
    return new WsRouteBuilder(
      this.#inner.param(name, schema),
      cloneOptions(this.#options),
    );
  }

  with<NewCtx extends Record<string, unknown>>(
    mw: MiddlewareFn<RouterCtx & RouteCtx, NewCtx>,
  ): WsRouteBuilder<RouterCtx, RouteCtx & NewCtx, Params> {
    return new WsRouteBuilder(
      this.#inner.with(mw),
      cloneOptions(this.#options),
    );
  }

  /** Terminal: plug in a reusable protocol handler (see `channels()`). */
  handleWith(
    handler: WsProtocolHandler<RouterCtx & RouteCtx, Params>,
  ): FinishedRoute {
    if (handler.protocols != null && this.#options.protocols == null) {
      this.#options.protocols = [...handler.protocols];
    }
    return this.#finish(handler.setup, handler.onBuild?.bind(handler));
  }

  /**
   * Terminal shorthand: resolve a hub from the container and register the
   * socket under the key derived from the handshake (e.g. the user id).
   */
  subscribe<H extends WsHub>(
    // biome-ignore lint/suspicious/noExplicitAny: intentional any
    token: abstract new (...args: any[]) => H,
    key: (args: WsHandlerArgs<RouterCtx & RouteCtx, Params>) => string,
  ): FinishedRoute {
    return this.handle((args) => {
      args.container.get(token).add(key(args), args.socket);
    });
  }

  /**
   * Terminal. Runs once per socket, after the upgrade. The returned function
   * (if any) runs when the socket closes.
   *
   * `.catch()` on the result only covers failures *before* the upgrade
   * (origin, middleware, params) — after that, errors close the socket.
   */
  handle(fn: WsHandlerFn<RouterCtx & RouteCtx, Params>): FinishedRoute {
    return this.#finish(fn);
  }

  #finish(
    fn: WsHandlerFn<RouterCtx & RouteCtx, Params>,
    onBuild?: (env: BuildEnv) => void,
  ): FinishedRoute {
    const options = cloneOptions(this.#options);
    const counter = options.maxConnections ? new ConnectionCounter() : null;

    let policy: OriginPolicy | undefined;
    let development = false;
    let logger: Logger = console;

    const route = this.#inner.handle((args) => {
      const { req } = args;
      const protocol = options.protocols
        ? negotiateProtocol(req, options.protocols)
        : null;

      const baseArgs = {
        path: args.path,
        ctx: args.ctx,
        req,
        container: args.container,
      };

      // Pre-upgrade connection limits — cheap rejection with a real status.
      const limit = options.maxConnections;
      let key: string | null = null;
      if (limit != null && counter != null) {
        if (limit.total != null && counter.total >= limit.total) {
          throw ServiceUnavailable();
        }
        if (limit.perKey != null) {
          key = limit.perKey.key(baseArgs);
          if (counter.count(key) >= limit.perKey.max) {
            throw new TooManyRequestsError("Too many connections");
          }
        }
      }

      const handlers = createLifecycle(
        req,
        protocol,
        (socket) => fn({ socket, ...baseArgs }),
        {
          maxMessageSize: options.maxMessageSize,
          rateLimit: options.rateLimit,
          maxQueuedMessages: options.maxQueuedMessages,
          development,
          logger,
          onOpen:
            counter == null
              ? undefined
              : (socket) => {
                  // Re-check: concurrent handshakes may both have passed above.
                  const overTotal =
                    limit?.total != null && counter.total >= limit.total;
                  const overKey =
                    key != null &&
                    limit?.perKey != null &&
                    counter.count(key) >= limit.perKey.max;
                  if (overTotal || overKey) {
                    throw new WsCloseError(
                      WsCloseCode.TryAgainLater,
                      "Too many connections",
                    );
                  }
                  socket.onClose(counter.acquire(key));
                },
        },
      );

      return requestUpgrade(req, {
        handlers,
        headers: protocol ? { "Sec-WebSocket-Protocol": protocol } : undefined,
      });
    });

    const definition = route.definition;
    definition.kind = "ws";
    definition.guards = [
      async (req) => {
        policy ??= createOriginPolicy(resolveOrigins(options, null).sources);
        if (!(await policy.check(req))) throw new ForbiddenOrigin();
        if (!isWebSocketUpgrade(req)) throw new UpgradeRequiredError();
        if (
          options.protocols != null &&
          negotiateProtocol(req, options.protocols) == null
        ) {
          throw new BadRequestError("Unsupported WebSocket subprotocol");
        }
      },
    ];
    definition.onBuild = (env) => {
      development = env.development;
      logger = env.logger;
      const { sources, wildcard } = resolveOrigins(options, env.cors);
      if (wildcard) {
        logger.warn(
          `[fishenv.ws] ${definition.path}: cors origin "*" is not applied to WebSocket routes (CSWSH); use .origin("any") to allow every origin`,
        );
      }
      policy = createOriginPolicy(sources);
      if (policy.allowsAny) {
        logger.warn(
          `[fishenv.ws] ${definition.path}: origin check disabled via .origin("any")`,
        );
      }
      const globalMax =
        env.websocket.maxPayloadLength ?? DEFAULT_MAX_PAYLOAD_LENGTH;
      if (
        options.maxMessageSize != null &&
        options.maxMessageSize > globalMax
      ) {
        logger.warn(
          `[fishenv.ws] ${definition.path}: maxMessageSize ${options.maxMessageSize} exceeds the server-wide maxPayloadLength ${globalMax}; the server limit wins`,
        );
      }
      onBuild?.(env);
    };

    return route;
  }
}

/** 403 without detail on which rule failed. */
class ForbiddenOrigin extends HttpError {
  constructor() {
    super(403, "Origin not allowed");
  }
  override get code(): string {
    return "forbidden";
  }
}

function resolveOrigins(
  options: WsRouteOptions,
  cors: BuildEnv["cors"],
): { sources: OriginSource[]; wildcard: boolean } {
  if (!options.inheritOrigins) {
    return { sources: [...options.origins], wildcard: false };
  }
  const inherited = originSourcesFromCors(cors);
  return {
    sources: [
      ...inherited.sources,
      ...options.routerOrigins,
      ...options.origins,
    ],
    wildcard: inherited.wildcard,
  };
}

function cloneOptions(options: WsRouteOptions): WsRouteOptions {
  return {
    ...options,
    routerOrigins: [...options.routerOrigins],
    origins: [...options.origins],
    rateLimit: options.rateLimit ? { ...options.rateLimit } : undefined,
  };
}
