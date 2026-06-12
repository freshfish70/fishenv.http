# fishenv.http — Open Questions

All questions requiring answers before or during implementation. Grouped by
area, ordered by impact on downstream decisions.

---

## Foundation

**Q1 — Validation library** Options: (a) **Standard Schema** interface
(library-agnostic — Valibot, Zod v4, ArkType all work), (b) **Valibot** only,
(c) **Zod** only. Standard Schema is the safest long-term choice but requires a
thin adapter layer per library. Which do you want? A: Valibot is a great default
for v1, and we can design the core types to be compatible with Standard Schema
in the future if we want to add it later.

**Q2 — Module identity** Should `ws/`, `sse/`, `static/`, `di/`, `openapi/`,
`client-gen/` be: (a) **Separate JSR packages** (`@fishenv/ws`, `@fishenv/di`,
etc.), or (b) **Sub-paths** of one package (`@fishenv/http/ws`,
`@fishenv/http/static`)? A: Sub-paths are simpler for users (one import) and
easier to maintain in a monorepo.

**Q3 — Deno version specifics** Any specific Deno 2.7+ APIs to mandate beyond
`Deno.serve`? (e.g. `Deno.serve` with `AbortSignal`, `AsyncDisposable`, TC39
decorators) A: Target Deno 2.7+ for `Deno.serve` with `AbortSignal` support.
AsyncDisposable is a nice-to-have for DI cleanup but not critical for v1.

---

## Routing & Path Matching

**Q6 — Path param auto-inference** Should `:id` in `/users/:id` automatically
appear as `path.id: string` without calling `.param()`, similar to Hono? Or
should params only be typed after explicit `.param("id", schema)` declaration?
A: Auto-infer path params as strings for convenience, with `.param()` allowing
schema override/coercion.

**Q7 — Wildcard key name** Should the wildcard `*` capture be available as
`path["*"]` or `path["rest"]` or something else? A: `path["*"]` is concise and
consistent with Hono's approach.

**Q8 — Case sensitivity** Case-sensitive path matching (standard HTTP behaviour)
— should there be an option to disable it? A: No, keep path matching
case-sensitive by default. Disabling it is non-standard and can lead to
confusion, so we won't offer that option for v1.

---

## Middleware

**Q9 — Post-handler work in middleware** The current design means middleware
cannot do work _after_ the handler runs (only interceptors can). Is this
intentional? If timing/logging middleware needs to wrap the handler call, we'd
need either interceptors or a `cleanup` return from middleware. Which model do
you prefer? A: Interceptors are a cleaner solution for pre/post handling logic.
Middleware should focus on pre-handler work (e.g. auth, input parsing), while
interceptors can wrap the handler for timing, logging, etc.

- But we need to make sure interceptors after handler can access the before
  context (e.g. a timer started in beforeFn should be readable in afterFn). This
  may require the RouteBuilder to carry separate context types for before and
  after.

**Q10 — Middleware error distinction** Should an error thrown in middleware be
distinguishable from an error thrown in a handler in the error handler callback?
(Useful for always returning 401 on auth failure regardless of the error type
thrown.) A: Middleware should throw typed `HttpError` instances (e.g.
`UnauthorizedError`) that carry status codes. Error handlers can check for these
types to determine the appropriate response, allowing distinction between auth
errors and handler bugs.

---

## Route Builder

**Q11 — Auto-serialization of plain object returns** If a handler returns a
plain object and `.output(Schema)` is defined, should the framework auto-wrap it
in `Response.json()`? Or must handlers always return a `Response`? A: Auto-wrap
plain objects with `Response.json()` when an output schema is defined. This
reduces boilerplate and allows handlers to return clean data objects without
manually creating a Response.

**Q12 — `.intercept()` position** The intro example shows
`.intercept(before, after)` called _before_ the HTTP method:

```typescript
route.intercept(beforeFn, afterFn).post("/abc");
```

But it also makes sense as a late-chain method after `.input()`. Which
convention do you want? A: Intercept should be after method selection (e.g.
`.post("/abc").intercept(before, after)`) to keep the builder pattern
consistent. The example can be updated to reflect this.

**Q13 — `.with()` variadic vs chained** Should `.with(A).with(B)` be the only
style, or also `.with(A, B)` variadic? Variadic is convenient but loses precise
type accumulation per step. A: Only chainable single `.with()` calls for better
type safety. const a = route.with(A) // Ctx = A const b = a.with(B) // Ctx = A &
B // or const b = route.with(A).with(B) // Ctx = A & B

const r = a.handle(...) // Ctx = A const r2 = b.handle(...) // Ctx = A & B

**Q47 — `route` vs `router` in examples** The intro uses a standalone `route`
variable not connected to a router instance. Should there be a standalone route
object, or do all routes belong to a router? (i.e. is
`router.post("/abc").with(...).handle()` always the pattern?) A: All routes
should belong to a router instance. The intro can be updated to show
`const route = router.post("/abc")...` to avoid confusion.

**Q48 — Handler return when no `.output()` defined** If the user omits
`.output()`, can the handler still return a plain object (gets serialized as
JSON), or is `Response` mandatory in that case? A: If no `.output()` is defined,
handlers must return a `Response` to avoid ambiguity. This encourages
explicitness in the API design.

---

## Router Class

**Q14 — Explicit `build()` vs lazy** Should `build()` be called explicitly
before `serve()`, or should the first incoming request trigger compilation
automatically? A: Explicit `build()` is preferable for predictability and
startup-time validation. It allows catching invalid route definitions early,
rather than at runtime on the first request.

**Q15 — Mutable vs immutable Router on `.use()`** Should `.use(mw)` return a
**new** Router instance (correct types, can't forget to reassign) or mutate in
place (simpler, but TypeScript loses track of accumulated context type)? A:
Returning a new Router instance from `.use()` is safer for TypeScript
correctness, as it ensures the context type is updated.

**Q16 — Multiple `serve()` calls** Should the same Router be serve()-able
multiple times? (Useful for tests — spin up, tear down, reuse.) A: Yes, allow
multiple `serve()` calls since `build()` is idempotent. This makes testing
easier without needing to create a new Router instance per test.

**Q17 — Container injection point** Should `DIContainer` be passed to
`serve({ container })` or bound to the Router? `serve()` is cleaner for testing
(swap mock container per test run). A: Pass the container to
`serve({ container })` so the same Router can be used with different containers
in tests.

**Q49 — `r()` naming** `r({ prefix: "/api" })` is very terse. Should the main
export be `r()` or something longer like `router()` or `createRouter()`? Or
export both? A: `r()` is concise and fits the builder pattern well. We can also
export `router()` as an alias for clarity, but `r()` can be the primary export
for brevity in examples.

**Q50 — HEAD method auto-handling** Should the framework auto-respond to `HEAD`
requests using the registered `GET` handler (stripping the body), or require
explicit `HEAD` registration? A: Auto-handle `HEAD` requests by invoking the
corresponding `GET` handler and stripping the body. This is standard HTTP
behavior and reduces boilerplate for users.

**Q51 — `serve()` vs `.fetch` property** Should there be a standalone
`serve(router, opts)` function _and_ a `.fetch` property on the router (for
testing without actually binding a port), similar to how Hono exposes
`app.fetch`? A: Yes, having both `serve(router, opts)` for production and
`router.fetch` for testing is a good idea. It allows users to easily test their
router logic without needing to start an actual server.

---

## Request Parsing

**Q18 — FormData coercion** Auto-coerce `FormData` to a plain
`Record<string, string | string[]>` before schema validation, or pass `FormData`
directly to the schema? A: Pass `FormData` directly to the schema. This allows
users to handle file uploads and other complex form data structures more
flexibly. If they want a plain object, they can transform it in middleware
before validation.

**Q19 — Bracket notation in form data** Support `user[name]=alice` bracket
notation for nested form fields (like `qs`)? Or keep it flat and recommend JSON
for nested data? A: Keep it flat and recommend JSON for nested data. Bracket
notation parsing adds complexity and can be error-prone.

**Q20 — Header normalization** Normalize all header names to lowercase before
validation (so `Content-Type` and `content-type` both work)? A: Yes, normalize
headers to lowercase before validation to align with HTTP's case-insensitivity
for headers.

---

## Error Handling

**Q21 — Configurable logger** Should `serve()` accept a `logger` option for
structured logging, or is `console.error` acceptable? A: Accept a `logger`
option in `serve()` for structured logging. This allows users to integrate with
their preferred logging libraries and formats, while still providing a default
fallback to `console.error` for simplicity.

**Q22 — Dev vs prod error details** Include stack traces in error responses in
development mode? Via `serve({ development: true })` or via `DENO_ENV`? A: Only
include stack traces when {{development: true }} is set, less magical and gives
users control over when to expose internals. By default, error responses should
be minimal for security.

**Q23 — Error types in `.output()` — runtime or docs only** The intro shows
`.output(Schema, [BadRequestError, UnauthorizedError])`. Are these error types
purely for OpenAPI documentation, or should the framework validate at runtime
that only declared error types escape the handler? A: These error types are for
documentation purposes only. Runtime validation of thrown error types would be
over-engineered and could impact performance. The framework should allow any
errors to be thrown, but encourage users to document expected errors for better
OpenAPI generation.

---

## Context & Async Local Storage

**Q24 — ALS on by default** Should Async Local Storage (enables `getCtx()`
anywhere in the call stack) be enabled by default or opt-in? A: Add option
`useAsyncLocalStorage: boolean` to `serve()`, defaulting to `false`. ALS has
some overhead, so it should be opt-in for users who need it.

**Q25 — ALS + fishenv.di integration** If DI needs request-scoped services (e.g.
a `UserSession` that reads the current user), should fishenv.http provide the
ALS store to the container, or does fishenv.di manage its own scoping
independently? A: fishenv.http should provide the ALS store to the DI container
when creating a request-scoped child container. This way, services can access
the current request context via ALS without fishenv.di needing to know about the
HTTP layer.

**Q26 — Type safety of `getCtx()`** `getCtx()` returns `Record<string, unknown>`
because the store type is erased at the call site. Accept this and require users
to cast, or provide a typed wrapper pattern? A: Provide a typed wrapper pattern
for `getCtx()`, allowing users to define their expected context shape while
acknowledging that the cast is unsafe. For example:

---

## WebSockets

**Q27 — WS in core vs separate module** The intro lists a `ws/` directory.
Should WS support require `import from "@fishenv/http/ws"`, or be available out
of the box from `@fishenv/http`? A: WS can be imported from `@fishenv/http/ws`
to keep the core package lean for users who don't need WS support.

**Q28 — Middleware on WS upgrade requests** Should router/route-level middleware
execute before the WebSocket handshake (for auth etc.)? Almost certainly yes —
confirming. A: Yes, middleware should run before the WebSocket handshake to
allow for authentication and other pre-upgrade logic.

**Q29 — Binary message types** Expose `MessageEvent` as-is (handles both string
and binary), or wrap with a typed API? A: Expose `MessageEvent` as-is to support
both string and binary messages without adding unnecessary abstraction.

---

## SSE

**Q30 — Multiline SSE data** Auto-split `\n` in data strings across multiple
`data:` lines per spec, or leave to the user? A: Auto-split `\n` in data strings
into multiple `data:` lines to ensure compliance with the SSE spec and simplify
user code.

**Q31 — Last-Event-ID on reconnect** Pass `Last-Event-ID` header value to the
handler for event replay support? A: Yes, pass `Last-Event-ID` to the handler so
users can implement event replay logic on reconnect.

**Q32 — Typed SSE events** `SseController<Events>` where `Events` is a
discriminated union of event types — v1 or v2? A: Consider for v2. While typed
events would be a nice developer experience improvement, it adds complexity to
the API and implementation. For v1, we can keep it simple with untyped events.

---

## Static Files

**Q33 — Range request support** Support HTTP `Range` / partial content (206) for
single-range requests (e.g. video seek)? Skip multi-range. A: Dont need to
support this now.

**Q34 — Pre-compressed file serving** If `.gz` / `.br` variants of a file exist
alongside the original, serve them automatically based on `Accept-Encoding`? A:
Yes, support serving pre-compressed files if they exist. This is a common
optimization for production assets and can be implemented without too much
complexity.

**Q35 — Extension pattern for static / ws / sse** How should optional modules
extend the Router? Options: (a) TypeScript module augmentation
(`declare module "@fishenv/http"`) (b) A mixin/plugin function:
`withStatic(router, ...)` (c) Subclass: `StaticRouter extends Router` A:
Mixin/plugin function is the most flexible and avoids the pitfalls of module
augmentation (which can lead to confusing types if not done carefully). For
example:

```typescriptimport { withStatic } from "@fishenv/http/static"
const router = withStatic(baseRouter, "/assets", { directory: "./public" })
```

This decision also covers Q27 for WS and applies identically to SSE.

**Q36 — Directory listing format** The intro mentions `directoryListing: false`
as an option. If enabled, should the listing be plain HTML or JSON? And is this
feature needed at all for v1? A: It can be true | 'html' | 'json', defaulting to
false.

**Q37 — Security headers for static files** Should static file serving
automatically add `X-Content-Type-Options: nosniff` and similar headers, or
leave that to user middleware? A: Yes, add `X-Content-Type-Options: nosniff` and
`Cache-Control: no-cache` by default for security and to prevent stale content.
Users can override these headers in middleware if needed.

---

## Streaming

**Q52 — Dedicated streaming route type** The intro has a full "Streaming
Responses" section but no dedicated plan file. Should there be a `.stream()`
route builder type (like `.sse()`, `.ws()`), or is returning a `ReadableStream`
from a regular `.handle()` sufficient? A: Returning a `ReadableStream` from a
regular `.handle()` is sufficient for v1. We can consider a dedicated
`.stream()` builder in v2 if we want to add streaming-specific features (e.g.
backpressure handling, stream lifecycle hooks).

---

## Dependency Injection

**Q38 — Decorator-based DI** Support `@Injectable` / `@Inject` TypeScript
decorators in fishenv.di for v1, or explicit `.bind()` API only? A: Dont do
anything regarding DI for now.

**Q39 — `Symbol.asyncDispose` for container cleanup** Implement
`[Symbol.asyncDispose]()` on the request-scoped container for cleanup (e.g.
closing DB connections after the request)? A: Dont do anything regarding DI for
now.

**Q40 — fishenv.di as separate JSR package** Separate `@fishenv/di` package
(users who don't need DI pay nothing), or always bundled with `@fishenv/http`?
A: Dont do anything regarding DI for now.

---

## OpenAPI

**Q41 — Schema-to-JSON-Schema adapter** Bundle a Valibot adapter for OpenAPI
generation, or require users to provide a converter function? A: Bundle a
Valibot adapter for OpenAPI generation to provide a seamless experience for
users using Valibot. (We are opinionated)

**Q42 — OpenAPI UI** Should `serveOpenApi()` also serve a Scalar/Swagger HTML
UI, or JSON spec only? A: Serve JSON spec only to keep the core package
lightweight. We can document how to point Scalar/Swagger at the generated spec
for users who want a UI.

**Q43 — OperationId generation** Auto-generate `operationId` from path+method
(e.g. `post_users_id`), or require explicit naming via
`.meta({ operationId: "..." })`? A: Auto-generate `operationId` from path+method
for convenience and consistency, while allowing override via route metadata for
users who want custom names.

---

## Client Generation

**Q44 — fishenv.wrq status** Does fishenv.wrq exist? If not, should the client
use raw `fetch` with a swappable `httpClient` option? A: Yes it exists,
https://jsr.io/@fishenv/wrq (its just a thin wrapper around fetch)

**Q45 — Client-side validation** Validate request bodies against the shared
schema before sending (opt-in via `validate: true`)? A: Yes, client-side
validation can be a nice DX improvement to catch errors early. We can make it
opt-in via a `validate: true` option on the client builder, since it requires
the schemas to be available on the client side.

**Q46 — Client auth / interceptors** How should auth headers/tokens be added to
client requests — a `headers` option, or middleware/interceptor hooks on the
client? A: wrq supports request/response hooks, so we can leverage those for
auth and other cross-cutting concerns. This allows users to add headers, log
requests, etc. without needing a separate configuration option.

---

## DI / Types

**Q4 — Standard Schema bundling** If we adopt the Standard Schema interface,
should the `@standard-schema/spec` types be bundled inline in `core/types.ts` or
listed as a peer dependency? A: List `@standard-schema/spec` as a peer
dependency to avoid forcing users to install it if they are using a different
validation library. We can provide our own `Schema` interface in `core/types.ts`
that matches the expected shape, and document that it is compatible with
`@standard-schema/spec` and other libraries.

**Q5 — DIContainer minimal interface** What is the minimal contract fishenv.http
needs from a DI container? At minimum:

```typescript
interface DIContainer {
  get<T>(token: abstract new (...args: any[]) => T): T;
}
```

Is this sufficient, or does the core need more (e.g. token-based lookup, child
scope creation)? A: This minimal `get()` interface is sufficient for the core to
interact with a DI container. More advanced features like child scope creation
can be handled by the DI library itself and are not required for the core to
function. The core just needs a way to retrieve instances based on constructor
tokens.
