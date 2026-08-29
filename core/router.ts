import type {
  BasePathParams,
  DIContainer,
  ErrorHandlerFn,
  HttpMethod,
  InputOptions,
  MiddlewareFn,
  NotFoundHandler,
  RouteDefinition,
} from "./types.ts";
import { buildCors, type CompiledCors, type CorsOptions } from "./cors.ts";
import {
  createRouteBuilder,
  type RouteBuilder,
  type RouterRef,
} from "./route-builder.ts";
import { Matcher } from "./matcher.ts";
import { dispatch } from "./compose.ts";
import {
  defaultErrorHandler,
  defaultMethodNotAllowedHandler,
  defaultNotFoundHandler,
} from "./error.ts";

const stubContainer: DIContainer = {
  get() {
    throw new Error(
      "No DI container configured. Pass one via serve() options.",
    );
  },
};

/**
 * Shared mutable state between a Router and all its .use() variants.
 * Routes registered on any variant end up in the same store.
 */
interface RouterStore {
  routes: RouteDefinition[];
  children: Router<Record<string, unknown>>[];
  locked: boolean;
}

/**
 * Router — immutable middleware chain, mutable route registration.
 *
 * `.use()` returns a new Router with the extended Ctx type but the same
 * backing store — routes registered on either instance are collected together.
 * Route methods (.get, .post, etc.) return a RouteBuilder chain.
 * Call `.build()` before `.fetch` or `serve()`.
 */
export class Router<Ctx extends Record<string, unknown> = Record<never, never>>
  implements RouterRef {
  readonly #prefix: string;
  readonly #middlewares: MiddlewareFn<
    Record<string, unknown>,
    Record<string, unknown>
  >[];
  readonly #store: RouterStore;
  #errorHandler?: ErrorHandlerFn;
  #notFoundHandler?: NotFoundHandler;
  #cors: CompiledCors | null = null;
  #built = false;
  #matcher: Matcher | null = null;
  #container: DIContainer = stubContainer;

  constructor(
    opts?: { prefix?: string },
    middlewares?: MiddlewareFn<
      Record<string, unknown>,
      Record<string, unknown>
    >[],
    errorHandler?: ErrorHandlerFn,
    notFoundHandler?: NotFoundHandler,
    store?: RouterStore,
  ) {
    this.#prefix = opts?.prefix ?? "";
    this.#middlewares = middlewares ?? [];
    this.#errorHandler = errorHandler;
    this.#notFoundHandler = notFoundHandler;
    this.#store = store ?? { routes: [], children: [], locked: false };
  }

  // ── RouterRef implementation ─────────────────────────────────────────

  _registerRoute(def: RouteDefinition): void {
    if (this.#store.locked) {
      throw new Error("Cannot add routes after build()");
    }
    this.#store.routes.push(def);
  }

  _getMiddlewares(): MiddlewareFn<
    Record<string, unknown>,
    Record<string, unknown>
  >[] {
    return [...this.#middlewares];
  }

  _getPrefix(): string {
    return this.#prefix;
  }

  // ── Middleware ────────────────────────────────────────────────────────

  use<NewCtx extends Record<string, unknown>>(
    mw: MiddlewareFn<Ctx, NewCtx>,
  ): Router<Ctx & NewCtx> {
    return new Router<Ctx & NewCtx>(
      { prefix: this.#prefix },
      [
        ...this.#middlewares,
        mw as MiddlewareFn<Record<string, unknown>, Record<string, unknown>>,
      ],
      this.#errorHandler,
      this.#notFoundHandler,
      this.#store, // share the same backing store
    );
  }

  // ── Sub-router ───────────────────────────────────────────────────────

  extend(opts?: { prefix?: string }): Router<Ctx> {
    const childPrefix = this.#prefix + (opts?.prefix ?? "");
    const child = new Router<Ctx>(
      { prefix: childPrefix },
      [...this.#middlewares],
      this.#errorHandler,
    );
    this.#store.children.push(
      child as unknown as Router<Record<string, unknown>>,
    );
    return child;
  }

  // ── Route methods ────────────────────────────────────────────────────

  get<P extends string>(
    path: P,
  ): RouteBuilder<
    Ctx,
    Record<never, never>,
    "none",
    InputOptions<"none">,
    BasePathParams<P>,
    undefined
  > {
    return createRouteBuilder<Ctx, P>(this, "GET", path);
  }

  post<P extends string>(
    path: P,
  ): RouteBuilder<
    Ctx,
    Record<never, never>,
    "none",
    InputOptions<"none">,
    BasePathParams<P>,
    undefined
  > {
    return createRouteBuilder<Ctx, P>(this, "POST", path);
  }

  put<P extends string>(
    path: P,
  ): RouteBuilder<
    Ctx,
    Record<never, never>,
    "none",
    InputOptions<"none">,
    BasePathParams<P>,
    undefined
  > {
    return createRouteBuilder<Ctx, P>(this, "PUT", path);
  }

  patch<P extends string>(
    path: P,
  ): RouteBuilder<
    Ctx,
    Record<never, never>,
    "none",
    InputOptions<"none">,
    BasePathParams<P>,
    undefined
  > {
    return createRouteBuilder<Ctx, P>(this, "PATCH", path);
  }

  delete<P extends string>(
    path: P,
  ): RouteBuilder<
    Ctx,
    Record<never, never>,
    "none",
    InputOptions<"none">,
    BasePathParams<P>,
    undefined
  > {
    return createRouteBuilder<Ctx, P>(this, "DELETE", path);
  }

  options<P extends string>(
    path: P,
  ): RouteBuilder<
    Ctx,
    Record<never, never>,
    "none",
    InputOptions<"none">,
    BasePathParams<P>,
    undefined
  > {
    return createRouteBuilder<Ctx, P>(this, "OPTIONS", path);
  }

  // ── Error / not-found ────────────────────────────────────────────────

  // ── CORS ─────────────────────────────────────────────────────────────

  cors(options: CorsOptions): this {
    this.#cors = buildCors(options);
    return this;
  }

  // ── Error / not-found ────────────────────────────────────────────────

  onError(handler: ErrorHandlerFn): this {
    this.#errorHandler = handler;
    return this;
  }

  notFound(handler: NotFoundHandler): this {
    this.#notFoundHandler = handler;
    return this;
  }

  // ── Container ────────────────────────────────────────────────────────

  /** @internal Set by serve(). For testing, call before build(). */
  _setContainer(container: DIContainer): void {
    this.#container = container;
  }

  // ── Build ────────────────────────────────────────────────────────────

  build(): void {
    if (this.#built) return; // idempotent

    const matcher = new Matcher();
    const allRoutes = this.#collectRoutes();

    for (const route of allRoutes) {
      matcher.add(route.method, route.path, route);
    }

    matcher.compile();
    this.#matcher = matcher;
    this.#built = true;
    this.#store.locked = true;
  }

  // ── Fetch ────────────────────────────────────────────────────────────

  /**
   * Entry point for request handling — available after build().
   * Use directly for testing without binding a port.
   */
  readonly fetch = async (req: Request): Promise<Response> => {
    if (!this.#built || !this.#matcher) {
      throw new Error("Router not built. Call .build() first.");
    }

    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const isHead = method === "HEAD";

    // CORS preflight — short-circuit before route matching
    if (method === "OPTIONS" && this.#cors) {
      return this.#cors.preflight(req);
    }

    // Try exact method match, then HEAD→GET fallback
    let matched = this.#matcher.match(method, url.pathname);

    if (isHead && (!matched || matched.allowedMethods)) {
      const getMatch = this.#matcher.match("GET", url.pathname);
      if (getMatch && !getMatch.allowedMethods) {
        matched = getMatch;
      }
    }

    if (!matched) {
      const notFound = this.#notFoundHandler ?? defaultNotFoundHandler;
      return notFound(req);
    }

    // 405 — path matched but method didn't
    if (matched.allowedMethods) {
      const allowed =
        isHead && !matched.allowedMethods.includes("HEAD" as HttpMethod)
          ? [...matched.allowedMethods, "HEAD" as HttpMethod]
          : matched.allowedMethods;
      return defaultMethodNotAllowedHandler(req, allowed);
    }

    // Build error handler chain: route catch → router onError → default
    const errorHandlers: ErrorHandlerFn[] = [];
    if (matched.definition.errorHandler) {
      errorHandlers.push(matched.definition.errorHandler);
    }
    if (this.#errorHandler) {
      errorHandlers.push(this.#errorHandler);
    }

    let response = await dispatch(
      req,
      matched.definition,
      matched.params,
      this.#container,
      errorHandlers,
    );

    // Inject CORS headers on every response
    if (this.#cors) {
      response = this.#cors.applyTo(req, response);
    }

    // HEAD: strip body
    if (isHead) {
      return new Response(null, {
        status: response.status,
        headers: response.headers,
      });
    }

    return response;
  };

  // ── Internal ─────────────────────────────────────────────────────────

  #collectRoutes(): RouteDefinition[] {
    const routes: RouteDefinition[] = [...this.#store.routes];
    for (const child of this.#store.children) {
      routes.push(...child.#collectRoutes());
    }
    return routes;
  }
}

// ── Factories ────────────────────────────────────────────────────────────

export function r<
  Ctx extends Record<string, unknown> = Record<never, never>,
>(opts?: { prefix?: string }): Router<Ctx> {
  return new Router<Ctx>(opts);
}

export const router = r;

// ── serve() ──────────────────────────────────────────────────────────────

export interface ServeOptions {
  port?: number;
  hostname?: string;
  container?: DIContainer;
  development?: boolean;
  logger?: Logger;
  signal?: AbortSignal;
  onListen?: (addr: { hostname: string; port: number }) => void;
}

export interface Logger {
  error(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
}

export function serve(
  app: Router<Record<string, unknown>>,
  options?: ServeOptions,
): Deno.HttpServer {
  if (options?.container) {
    app._setContainer(options.container);
  }
  app.build(); // idempotent
  return Deno.serve(
    {
      port: options?.port ?? 8000,
      hostname: options?.hostname ?? "0.0.0.0",
      signal: options?.signal,
      onListen: options?.onListen,
    },
    (req) => app.fetch(req),
  );
}
