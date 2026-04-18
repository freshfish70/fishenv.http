# 06 — Router Class & `r()` / `router()` Factories

## Decisions
- **Naming**: `r()` is the primary export; `router()` is an alias. Both exported from `core/mod.ts`.
- **Immutability**: `.use()` returns a **new** Router instance with updated `Ctx` type.
- **`build()`**: Must be called explicitly before `serve()`. Validates paths at compile time.
- **Multiple `serve()` calls**: Allowed — `build()` is idempotent.
- **Container**: Passed to `serve({ container })`, not bound to the Router.
- **HEAD**: Auto-handled from GET (matcher falls back, dispatch strips body).
- **Testing**: Router exposes a `.fetch` property for test use without binding a port.

## API

```typescript
import { r, router, serve } from "@fishenv/http"

// Primary factory
const api = r({ prefix: "/api" })
  .use(CorsMiddleware)     // returns new Router<{ cors: true }>
  .use(AuthMiddleware)     // returns new Router<{ cors: true; user: User }>

api.get("/users").handle(({ ctx }) => Response.json(ctx.user))

// Sub-router — inherits parent middleware
const admin = api.extend({ prefix: "/admin" })
  .use(AdminGuard)         // ctx now has { cors: true; user: User; isAdmin: true }

admin.delete("/users/:id").handle(...)

// Production
const server = serve(api, { port: 8080, container: myContainer })

// Testing (no port binding)
const res = await api.fetch(new Request("http://localhost/api/users"))
```

## Class Structure

```typescript
class Router<Ctx extends Record<string, unknown> = {}> {
  readonly #prefix: string
  readonly #middlewares: MiddlewareFn<any, any>[]
  readonly #errorHandler?: ErrorHandlerFn
  readonly #notFoundHandler?: NotFoundHandler
  readonly #routes: RouteDefinition[] = []
  readonly #children: Router<any>[] = []

  // ── Middleware ──────────────────────────────────────────────────────────

  use<NewCtx extends Record<string, unknown>>(
    mw: MiddlewareFn<Ctx, NewCtx>,
  ): Router<Ctx & NewCtx>
  // Returns new Router with Ctx & NewCtx. Does NOT mutate this.

  // ── Sub-router ──────────────────────────────────────────────────────────

  extend(opts?: { prefix?: string }): Router<Ctx>
  // Creates child Router. Child inherits this.#middlewares and this.#errorHandler.
  // Child is registered in this.#children so build() can collect its routes.

  // ── Route methods ────────────────────────────────────────────────────────

  get<P extends string>(path: P): RouteBuilder<Ctx, {}, "none", {}, BasePathParams<P>, undefined>
  post<P extends string>(path: P): RouteBuilder<...>
  put<P extends string>(path: P): RouteBuilder<...>
  patch<P extends string>(path: P): RouteBuilder<...>
  delete<P extends string>(path: P): RouteBuilder<...>
  options<P extends string>(path: P): RouteBuilder<...>

  // ── Error / not-found ────────────────────────────────────────────────────

  onError(handler: ErrorHandlerFn): this    // mutates, no type change
  notFound(handler: NotFoundHandler): this  // mutates

  // ── Build & serve ────────────────────────────────────────────────────────

  build(): void
  // Compiles the Matcher. Must be called before serve() or .fetch.
  // Throws if called after routes are added post-build.
  // Idempotent — safe to call multiple times.

  readonly fetch: (req: Request) => Promise<Response>
  // Available after build(). Used for testing.

  // ── Internal ─────────────────────────────────────────────────────────────

  #registerRoute(def: RouteDefinition): void
  #collectRoutes(): ResolvedRoute[]   // flatten self + children recursively
}
```

## Route Collection

When `build()` is called, it walks the entire router tree and resolves each route:

```typescript
interface ResolvedRoute extends RouteDefinition {
  middlewares: MiddlewareFn<any, any>[]   // router chain + route chain, flattened
  errorHandlers: ErrorHandlerFn[]         // route catch → router onError → ... → default
}

// Inheritance:
// api.use(cors).use(auth)
// └─ admin = api.extend().use(adminGuard)
//    └─ route: DELETE /admin/users/:id
//       middlewares: [cors, auth, adminGuard, ...route.middlewares]
//       errorHandlers: [route.catch, admin.onError, api.onError, defaultErrorHandler]
```

## `serve()` Function

```typescript
interface ServeOptions {
  port?: number              // default: 8000
  hostname?: string          // default: "0.0.0.0"
  container?: DIContainer    // injected per-request into handler args
  development?: boolean      // include stack traces in error responses (default: false)
  logger?: Logger            // structured logger; falls back to console.error
  useAsyncLocalStorage?: boolean  // default: false
  onListen?: (addr: { hostname: string; port: number }) => void
  signal?: AbortSignal       // for graceful shutdown (Deno.serve native support)
}

interface Logger {
  error(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
}

function serve(router: Router<any>, options?: ServeOptions): Deno.HttpServer {
  router.build()   // idempotent — safe to call if already built
  return Deno.serve(
    { port: options?.port ?? 8000, hostname: options?.hostname ?? "0.0.0.0",
      signal: options?.signal, onListen: options?.onListen },
    (req) => router.fetch(req),  // .fetch is the compiled handler
  )
}
```

## `.fetch` Property

`router.fetch` is assigned during `build()` and acts as the entry point:

```typescript
// After build():
router.fetch = async (req: Request): Promise<Response> => {
  const url = new URL(req.url)
  const method = req.method.toUpperCase()

  // HEAD fallback handled inside dispatch
  const matched = matcher.match(method === "HEAD" ? "HEAD" : method, url.pathname)
    ?? (method === "HEAD" ? matcher.match("GET", url.pathname) : null)

  if (!matched) {
    if (matched?.allowedMethods) {
      return new Response(null, {
        status: 405,
        headers: { Allow: matched.allowedMethods.join(", ") }
      })
    }
    return notFoundHandler(req)
  }

  const isHead = method === "HEAD"
  const response = await dispatch(req, matched, container, errorHandlers)

  if (isHead) return new Response(null, { status: response.status, headers: response.headers })
  return response
}
```

## `r()` and `router()` Factories

```typescript
function r<Ctx extends Record<string, unknown> = {}>(opts?: { prefix?: string }): Router<Ctx> {
  return new Router(opts)
}

const router = r   // alias
export { r, router, serve }
```

## Files to Create
- `core/router.ts` — `Router` class
- `core/mod.ts` — exports `r`, `router`, `serve`, re-exports types
- `core/router.test.ts` — integration tests: middleware inheritance, sub-routers, HEAD fallback, error chain, `.fetch` for testing
