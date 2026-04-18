# 05 — Route Builder (Fluent Chain)

## Decisions
- **All routes belong to a router** — no standalone `route` object.
- **`.intercept()` position**: after method selection, in the builder chain.
- **`.with()` style**: chained single calls only — `.with(A).with(B)`. No variadic `.with(A, B)`.
- **Auto-serialization**: `.output()` defined → handler may return plain object → auto-wrapped in `Response.json()`.
- **No output schema**: handler must return `Response`.
- **`.intercept(before?, after?)`** — both optional, shared state object passed to both.

## Complete API Example

```typescript
const route = router.post("/resources/:id")
  .meta({ title: "Update Resource", tags: ["resources"] })
  .param("id", v.pipe(v.string(), v.uuid()))
  .with(AuthMiddleware)          // ctx now has { user: User }
  .with(LogMiddleware)           // ctx now has { user: User; log: Logger }
  .input("json", {
    body: UpdateResourceSchema,
    headers: v.object({ "x-trace-id": v.string() }),
    query: v.object({ dry: v.optional(v.boolean()) }),
  })
  .output(ResourceSchema, [NotFoundError, UnauthorizedError])
  .intercept(
    ({ req, ctx, state }) => { state.start = performance.now() },
    ({ response, state }) => {
      response.headers.set("X-Time", String(performance.now() - (state.start as number)))
      return response
    }
  )
  .handle(async ({ path, ctx, body, container }) => {
    const svc = container.get(ResourceService)
    return svc.update(path.id, body)    // returns plain object → auto-wrapped as JSON
  })
  .catch((err, { req }) => {
    if (err instanceof NotFoundError) return err.toResponse()
  })
```

## Class Signature

```typescript
class RouteBuilder<
  RouterCtx extends Record<string, unknown>,    // from router .use() chain
  RouteCtx extends Record<string, unknown>,     // from .with() chain
  K extends InputKind,
  O extends InputOptions<K>,
  Params extends Record<string, unknown>,       // grows with .param()
  Output,                                       // undefined until .output() is called
> {
  // Internal state
  readonly #router: RouterRef
  readonly #method: HttpMethod
  readonly #path: string
  #middlewares: MiddlewareFn<any, any>[] = []
  #paramSchemas = new Map<string, AnySchema>()
  #inputKind: InputKind = "none"
  #inputOptions: InputOptions<InputKind> = {}
  #outputSchema?: AnySchema
  #errorTypes?: (new (...args: any[]) => HttpError)[]
  #meta?: RouteMeta
  #interceptors: InterceptorPair<any>[] = []

  meta(data: RouteMeta): this

  param<Name extends string & keyof Params, S extends AnySchema>(
    name: Name,
    schema: S,
  ): RouteBuilder<RouterCtx, RouteCtx, K, O, MergeParam<Params, Name, S>, Output>

  with<NewCtx extends Record<string, unknown>>(
    mw: MiddlewareFn<RouterCtx & RouteCtx, NewCtx>,
  ): RouteBuilder<RouterCtx, RouteCtx & NewCtx, K, O, Params, Output>

  input<NK extends InputKind, NO extends InputOptions<NK>>(
    kind: NK,
    options?: NO,
  ): RouteBuilder<RouterCtx, RouteCtx, NK, NO, Params, Output>

  output<S extends AnySchema>(
    schema: S,
    errors?: (new (...args: any[]) => HttpError)[],
  ): RouteBuilder<RouterCtx, RouteCtx, K, O, Params, InferOutput<S>>

  intercept(
    before?: BeforeInterceptorFn<RouterCtx & RouteCtx>,
    after?: AfterInterceptorFn<RouterCtx & RouteCtx>,
  ): this

  handle(
    fn: HandlerFn<RouterCtx & RouteCtx, K, O, Params, Output>,
  ): FinishedRoute

  // handle() registers the route on the router and returns a FinishedRoute
}
```

## FinishedRoute

```typescript
class FinishedRoute {
  readonly definition: RouteDefinition   // for testing / introspection

  catch(fn: ErrorHandlerFn): this
  // Terminal — no further builder methods
}
```

`handle()` internally:
1. Assembles the `RouteDefinition` from accumulated builder state
2. Merges router-level middlewares (prepended) with route-level middlewares
3. Calls `router.#registerRoute(def)`
4. Returns a `FinishedRoute`

## Handler Type Enforcement

When `.output(Schema)` is defined, TypeScript enforces that the handler return type is assignable to `Response | InferOutput<Schema> | Promise<...>`. When omitted, only `Response | Promise<Response>` is accepted:

```typescript
// Output defined: both allowed
.output(UserSchema)
.handle(async () => ({ id: 1, name: "Alice" }))   // ✓ plain object
.handle(async () => new Response("ok"))             // ✓ Response

// No output: only Response
.handle(async () => ({ id: 1 }))    // ✗ TypeScript error
.handle(async () => new Response()) // ✓
```

## Path Param Narrowing

Auto-inferred params come from the path string. `.param()` narrows:

```typescript
router.get("/users/:id/posts/:pid")
// path: { id: string; pid: string }

.param("id", v.pipe(v.string(), v.uuid()))
// path: { id: string; pid: string }  — uuid is still string at type level

.param("pid", v.pipe(v.string(), v.transform(Number)))
// path: { id: string; pid: number }  — pid coerced to number
```

## Builder Immutability

Each method that changes the generic type signature returns a **new** instance. Methods that only add runtime data (`.meta()`, `.intercept()`) mutate and return `this` for convenience since they don't affect the TypeScript type.

## Files to Create
- `core/route-builder.ts` — `RouteBuilder`, `FinishedRoute`
- `core/route-builder.test.ts` — type tests + runtime behaviour tests
