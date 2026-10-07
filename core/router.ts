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
  createRouteBuilderFromContract,
  type RouteBuilder,
  type RouterRef,
} from "./route-builder.ts";
import type { AnyContractBuilder, ContractShape } from "@fishenv/http-contract";
import { Matcher } from "./matcher.ts";
import { dispatch } from "./compose.ts";
import {
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

// deno-lint-ignore no-explicit-any
type AnyRouter = Router<any, any>;

/**
 * A router mounted via `.add()`, together with the prefix and middleware of
 * the parent variant it was mounted on. Applied to the child's routes at build().
 */
interface MountedRouter {
  router: AnyRouter;
  prefix: string;
  middlewares: MiddlewareFn<Record<string, unknown>, Record<string, unknown>>[];
}

/**
 * Shared mutable state between a Router and all its .use() variants.
 * Routes registered on any variant end up in the same store.
 */
interface RouterStore {
  routes: RouteDefinition[];
  children: MountedRouter[];
  locked: boolean;
}

/**
 * Router — immutable middleware chain, mutable route registration.
 *
 * `.use()` returns a new Router with the extended Ctx type but the same
 * backing store — routes registered on either instance are collected together.
 * Route methods (.get, .post, etc.) return a RouteBuilder chain.
 * Call `.build()` before `.fetch` or `serve()`.
 *
 * `Requires` is the context this router expects a parent to provide when it
 * is mounted via `.add()`. Create one with `r<AppCtx>()`; `.add()` only
 * accepts it on a parent whose `Ctx` satisfies `AppCtx`, and `serve()` only
 * accepts routers with no outstanding requirements.
 */
export class Router<
  Ctx extends Record<string, unknown> = Record<never, never>,
  Requires extends Record<string, unknown> = Record<never, never>,
> implements RouterRef {
  /** @internal Phantom — makes `Requires` contravariant for `.add()` checks. */
  declare readonly _requires?: (ctx: Requires) => void;
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
  ): Router<Ctx & NewCtx, Requires> {
    return new Router<Ctx & NewCtx, Requires>(
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

  /** Create a child router and mount it on this one — shorthand for `r<Ctx>(opts)` + `.add()`. */
  extend(opts?: { prefix?: string }): Router<Ctx, Ctx> {
    const child = new Router<Ctx, Ctx>(opts);
    this.add(child);
    return child;
  }

  /**
   * Mount routers defined elsewhere, optionally under an extra prefix:
   *
   * ```ts
   * app.add(users, posts);
   * app.add("/v1", users);
   * ```
   *
   * Each child's routes get this router's prefix and middleware prepended at
   * build(). A child created with `r<AppCtx>()` only type-checks here if this
   * router's context provides `AppCtx`.
   */
  // deno-lint-ignore no-explicit-any
  add(...children: Router<any, Ctx>[]): this;
  // deno-lint-ignore no-explicit-any
  add(prefix: string, ...children: Router<any, Ctx>[]): this;
  add(...args: (string | AnyRouter)[]): this {
    if (this.#store.locked) {
      throw new Error("Cannot add routers after build()");
    }
    const extra = typeof args[0] === "string" ? args.shift() as string : "";
    for (const child of args as AnyRouter[]) {
      this.#store.children.push({
        router: child,
        prefix: this.#prefix + extra,
        middlewares: [...this.#middlewares],
      });
    }
    return this;
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

  // ── Contract-driven route ────────────────────────────────────────────

  /**
   * Register a route from a `@fishenv/http-contract` endpoint definition, e.g.:
   *
   * ```ts
   * router.contract(contract.users.create).handle(({ body }) => { ... });
   * ```
   *
   * `.handle()` gets exactly the same type safety (body/query/params/output)
   * as chaining `.input().output().param()` manually, because the contract
   * endpoint and the route builder share the same shape types.
   */
  contract<C extends AnyContractBuilder>(
    endpoint: C,
  ): RouteBuilder<
    Ctx,
    Record<never, never>,
    ContractShape<C>["inputKind"],
    ContractShape<C>["inputOptions"],
    ContractShape<C>["params"],
    ContractShape<C>["output"]
  > {
    return createRouteBuilderFromContract<Ctx, C>(this, endpoint);
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
    if (matched.definition.routerErrorHandlers) {
      errorHandlers.push(...matched.definition.routerErrorHandlers);
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

  /**
   * Flatten this router's routes plus all mounted children. Child routes are
   * copied (a child may be mounted more than once) with the mount prefix and
   * middleware prepended and the child's onError appended to the chain.
   * Locks every visited store.
   */
  #collectRoutes(visiting = new Set<RouterStore>()): RouteDefinition[] {
    if (visiting.has(this.#store)) {
      throw new Error("Router mount cycle detected");
    }
    visiting.add(this.#store);
    this.#store.locked = true;

    const routes: RouteDefinition[] = [...this.#store.routes];
    for (const { router: child, prefix, middlewares } of this.#store.children) {
      if (child.#cors || child.#notFoundHandler) {
        throw new Error(
          "cors() and notFound() are only supported on the root router",
        );
      }
      for (const def of child.#collectRoutes(visiting)) {
        routes.push({
          ...def,
          path: prefix + def.path,
          middlewares: [...middlewares, ...def.middlewares],
          routerErrorHandlers: child.#errorHandler
            ? [...(def.routerErrorHandlers ?? []), child.#errorHandler]
            : def.routerErrorHandlers,
        });
      }
    }

    visiting.delete(this.#store);
    return routes;
  }
}

// ── Factories ────────────────────────────────────────────────────────────

/**
 * Create a router. Pass a context type to declare what a parent must provide
 * when this router is mounted with `.add()`:
 *
 * ```ts
 * // context.ts
 * export const base = r().use(auth);
 * export type AppCtx = CtxOf<typeof base>;
 *
 * // users.ts — type-only import, no runtime cycle
 * export const users = r<AppCtx>({ prefix: "/users" });
 *
 * // main.ts
 * serve(base.add(users));
 * ```
 */
export function r<
  Req extends Record<string, unknown> = Record<never, never>,
>(opts?: { prefix?: string }): Router<Req, Req> {
  return new Router<Req, Req>(opts);
}

export const router = r;

/** The context type a router's handlers receive. */
export type CtxOf<R> = R extends Router<infer C, infer _> ? C : never;

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
  // deno-lint-ignore no-explicit-any
  app: Router<any, Record<never, never>>,
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
