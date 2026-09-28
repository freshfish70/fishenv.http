/** Fluent builder for SSE routes, layered on the core `RouteBuilder`. */

import type {
  AnySchema,
  DIContainer,
  FinishedRoute,
  InputOptions,
  MergeParam,
  MiddlewareFn,
  RouteBuilder,
  RouteMeta,
} from "@fishenv/http";
import type { SseConnection } from "./connection.ts";
import type { SseHub } from "./hub.ts";
import { createSseResponse } from "./response.ts";
import type {
  SseCleanupFn,
  SseConnectionOptions,
  SseOverflowPolicy,
} from "./types.ts";

export interface SseHandlerArgs<
  Ctx extends Record<string, unknown>,
  Params extends Record<string, unknown>,
> {
  sse: SseConnection;
  path: Params;
  ctx: Ctx;
  req: Request;
  container: DIContainer;
}

export type SseHandlerFn<
  Ctx extends Record<string, unknown>,
  Params extends Record<string, unknown>,
> = (
  args: SseHandlerArgs<Ctx, Params>,
) => void | SseCleanupFn | Promise<void | SseCleanupFn>;

/**
 * Delegates to the core `RouteBuilder`, so `.param()` / `.with()` carry exactly
 * the same generics as HTTP routes.
 */
export class SseRouteBuilder<
  RouterCtx extends Record<string, unknown>,
  RouteCtx extends Record<string, unknown>,
  Params extends Record<string, unknown>,
> {
  readonly #inner: RouteBuilder<
    RouterCtx,
    RouteCtx,
    "none",
    InputOptions<"none">,
    Params,
    undefined
  >;
  readonly #options: SseConnectionOptions;

  constructor(
    inner: RouteBuilder<
      RouterCtx,
      RouteCtx,
      "none",
      InputOptions<"none">,
      Params,
      undefined
    >,
    options: SseConnectionOptions = {},
  ) {
    this.#inner = inner;
    this.#options = options;
  }

  meta(data: RouteMeta): this {
    this.#inner.meta(data);
    return this;
  }

  /** Heartbeat interval. Also how the server notices a socket died. */
  keepalive(intervalMs: number): this {
    this.#options.keepaliveMs = intervalMs;
    return this;
  }

  /** Reconnection delay hint sent to the client on connect. */
  retry(ms: number): this {
    this.#options.retryMs = ms;
    return this;
  }

  backpressure(opts: {
    highWaterMark?: number;
    onOverflow?: SseOverflowPolicy;
  }): this {
    if (opts.highWaterMark != null) {
      this.#options.highWaterMark = opts.highWaterMark;
    }
    if (opts.onOverflow != null) this.#options.onOverflow = opts.onOverflow;
    return this;
  }

  param<Name extends string & keyof Params, S extends AnySchema>(
    name: Name,
    schema: S,
  ): SseRouteBuilder<RouterCtx, RouteCtx, MergeParam<Params, Name, S>> {
    return new SseRouteBuilder(this.#inner.param(name, schema), {
      ...this.#options,
    });
  }

  with<NewCtx extends Record<string, unknown>>(
    mw: MiddlewareFn<RouterCtx & RouteCtx, NewCtx>,
  ): SseRouteBuilder<RouterCtx, RouteCtx & NewCtx, Params> {
    return new SseRouteBuilder(this.#inner.with(mw), { ...this.#options });
  }

  /**
   * Terminal. The returned function (if any) runs when the connection closes.
   *
   * `.catch()` on the result only covers failures raised *before* the stream
   * opens (middleware, param validation) — after that the status is already sent.
   */
  handle(fn: SseHandlerFn<RouterCtx & RouteCtx, Params>): FinishedRoute {
    const options = { ...this.#options };

    const route = this.#inner.handle(({ req, path, ctx, container }) =>
      createSseResponse(req, options, (sse) =>
        fn({ sse, path, ctx, req, container }),
      ),
    );

    route.definition.kind = "sse";
    return route;
  }

  /**
   * Terminal shorthand: resolve a hub from the container and register the
   * connection under the key derived from the request.
   */
  subscribe<H extends SseHub>(
    // deno-lint-ignore no-explicit-any
    token: abstract new (...args: any[]) => H,
    key: (args: SseHandlerArgs<RouterCtx & RouteCtx, Params>) => string,
  ): FinishedRoute {
    return this.handle((args) =>
      args.container.get(token).add(key(args), args.sse),
    );
  }
}
