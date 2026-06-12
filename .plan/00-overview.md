# fishenv.http — Implementation Plan Overview

## Resolved Decisions

| Topic                      | Decision                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| Validation library         | **Valibot** for v1; types designed for future Standard Schema compatibility               |
| Module identity            | Single package `@fishenv/http` with **sub-path exports** (`/ws`, `/sse`, etc.)            |
| Deno target                | **2.7+** — `Deno.serve` with `AbortSignal`                                                |
| Path params                | **Auto-inferred as `string`**; `.param()` narrows/coerces                                 |
| Wildcard key               | `path["*"]`                                                                               |
| Case sensitivity           | Always case-sensitive; no option to disable                                               |
| Middleware post-handler    | **Interceptors only** (`.intercept(before, after)`)                                       |
| Interceptor state sharing  | Mutable `state: Record<string, unknown>` object passed to both `before` and `after`       |
| Middleware errors          | Throw typed `HttpError` subclasses                                                        |
| Auto-serialization         | Plain object → `Response.json()` when `.output()` is defined; else must return `Response` |
| `.intercept()` position    | After method selection in builder chain                                                   |
| `.with()` style            | Chained single calls only                                                                 |
| Standalone `route`         | No — all routes belong to a router instance                                               |
| `build()`                  | **Explicit** — called before `serve()`                                                    |
| Router mutability          | **Immutable** — `.use()` returns a new Router instance                                    |
| Multiple `serve()`         | Allowed — `build()` is idempotent                                                         |
| Container injection        | `serve({ container })`                                                                    |
| Primary export name        | `r()` + `router()` alias                                                                  |
| HEAD handling              | **Auto** — falls back to GET handler, body stripped                                       |
| `.fetch` for testing       | Yes — both `serve()` and `router.fetch`                                                   |
| FormData                   | Passed directly to schema (no auto-coerce)                                                |
| Bracket notation           | Not supported — recommend JSON                                                            |
| Header normalization       | Lowercased before validation                                                              |
| Logger                     | `serve({ logger })` option; fallback to `console.error`                                   |
| Dev mode errors            | Stack traces only when `serve({ development: true })`                                     |
| Error types in `.output()` | Documentation/OpenAPI only                                                                |
| ALS                        | `serve({ useAsyncLocalStorage: true })`; default off                                      |
| ALS + DI                   | fishenv.http provides ALS store to container                                              |
| `getCtx()` typing          | Typed wrapper pattern                                                                     |
| WS location                | `@fishenv/http/ws`                                                                        |
| WS middleware              | Runs before handshake                                                                     |
| WS binary                  | `MessageEvent` as-is                                                                      |
| SSE multiline              | Auto-split `\n`                                                                           |
| SSE Last-Event-ID          | Exposed as `sse.lastEventId`                                                              |
| Typed SSE events           | v2                                                                                        |
| Range requests             | Not in v1                                                                                 |
| Pre-compressed static      | Serve `.gz`/`.br` automatically                                                           |
| Extension pattern          | **Mixin functions**: `withWs()`, `withSse()`, `withStatic()`                              |
| Directory listing          | `true \| "html" \| "json"` — default `false`                                              |
| Static security headers    | `X-Content-Type-Options: nosniff` + `Cache-Control: no-cache` by default                  |
| Streaming                  | `ReadableStream` returned from regular `.handle()` — no dedicated builder                 |
| DI                         | **Skipped for v1** — only `DIContainer` interface stub                                    |
| OpenAPI schema adapter     | Bundle Valibot adapter; allow custom                                                      |
| OpenAPI UI                 | JSON spec only                                                                            |
| OperationId                | Auto-generated from method+path; overridable via `.meta()`                                |
| fishenv.wrq                | Exists at `jsr:@fishenv/wrq`                                                              |
| Client-side validation     | Opt-in via `validate: true`                                                               |
| Client auth                | Delegate to wrq's `hooks.onRequest`                                                       |

---

## Implementation Order

| Step | File                        | Description                                    | Depends On |
| ---- | --------------------------- | ---------------------------------------------- | ---------- |
| 01   | `01-project-setup.md`       | Deno workspace, directory layout, module stubs | —          |
| 02   | `02-core-types.md`          | All TypeScript types and interfaces            | 01         |
| 03   | `03-router-matching.md`     | Path pattern matching engine                   | 02         |
| 04   | `04-middleware-pipeline.md` | Middleware compose + dispatch                  | 02, 03     |
| 05   | `05-route-builder.md`       | Fluent RouteBuilder chain                      | 02, 04     |
| 06   | `06-router-class.md`        | Router class + `r()`/`router()` + `serve()`    | 03, 04, 05 |
| 07   | `07-request-parsing.md`     | Body parsing + schema validation               | 02         |
| 08   | `08-error-handling.md`      | Error classes + handler chain                  | 02         |
| 09   | `09-context-als.md`         | Async Local Storage                            | 04, 06     |
| 10   | `10-websockets.md`          | WebSocket mixin (`withWs`)                     | 05, 06     |
| 11   | `11-sse.md`                 | SSE mixin (`withSse`)                          | 05, 06     |
| 12   | `12-static-files.md`        | Static file mixin (`withStatic`)               | 06         |
| 13   | `13-di-integration.md`      | DI stub + interface only                       | 02         |
| 14   | `14-openapi.md`             | OpenAPI spec generation                        | 05, 06, 08 |
| 15   | `15-client-gen.md`          | RPC client (uses fishenv.wrq)                  | 14         |

## Critical Path

**01 → 02 → 03 → 04 → 05 → 06** forms the critical path. All extensions build on
this.

Steps 07 and 08 are independent and can be developed in parallel once 02 is
done. Steps 10–12 can begin after 06 is solid. Steps 14–15 are last — they
require a complete route registry.

## Key Design Differentiators vs Hono

| Feature              | Hono                                   | fishenv.http                                                                  |
| -------------------- | -------------------------------------- | ----------------------------------------------------------------------------- |
| Route definition     | `app.get(path, ...handlers)`           | `router.get(path).with(...).input(...).handle(fn)`                            |
| Middleware context   | `Env.Variables` generics               | Accumulated intersection type — immutable `.use()`                            |
| Middleware signature | `(c, next) => void` — `next()` footgun | `(ctx) => NewFields` — no `next()`                                            |
| Post-handler work    | Via `await next()` in middleware       | Explicit `.intercept(before, after)` with shared `state`                      |
| Input validation     | External validator middleware          | First-class `.input("json", { body: Schema })`                                |
| Output typing        | Manual                                 | `.output(Schema)` auto-serializes and type-checks return                      |
| DI                   | None                                   | `container.get(Service)` in every handler (v2)                                |
| OpenAPI              | Third-party                            | Built-in from `.meta()` + `.input()` + `.output()`                            |
| WS/SSE               | Via adapters                           | First-class sub-path modules                                                  |
| Extensions           | N/A                                    | Mixin pattern: `withWs(router)`, `withSse(router)`, `withStatic(router, ...)` |

## Non-Goals for v1

- Decorator-based DI (`@Injectable`, `@Inject`)
- DI implementation of any kind
- HTTP Range requests
- Multi-range requests
- Runtime compression of responses
- Typed SSE events (`SseController<Events>`)
- Code-gen client (only runtime client from shared router)
- OpenAPI UI (Scalar/Swagger)
- Case-insensitive routing
- Bracket notation in form data
- fishenv.di package
