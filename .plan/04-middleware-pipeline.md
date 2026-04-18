# 04 — Middleware Pipeline

## Decisions
- **Middleware model**: Context-returning `(ctx) => Partial<NewCtx>`. No `next()`. Runs only before the handler.
- **Post-handler work**: Interceptors only. Middleware cannot wrap the handler.
- **Error distinction**: Middleware should throw typed `HttpError` instances. Error handlers check instance type.
- **Interceptor shared state**: A plain mutable object `state: Record<string, unknown>` is created per-request and passed to both `before` and `after` interceptor functions — enabling e.g. a timer started in `before` to be read in `after`.
- **Error chain**: `route.catch` → `router.onError` → built-in fallback. Each handler returns `Response | null/void` (null = pass to next).

## Middleware Execution

```typescript
// core/compose.ts

async function runMiddlewarePipeline(
  req: Request,
  middlewares: MiddlewareFn<any, any>[],
  container: DIContainer,
): Promise<Record<string, unknown>> {
  let ctx: Record<string, unknown> = { req }
  for (const mw of middlewares) {
    const additions = await mw({ ...ctx, container })
    ctx = { ...ctx, ...additions }
  }
  return ctx
}
```

Type safety is enforced at the builder level (compile time). Runtime merging is plain object spread — no magic.

## Interceptors with Shared State

```typescript
async function runInterceptors(
  interceptors: InterceptorPair<any>[],
  req: Request,
  ctx: Record<string, unknown>,
  handlerFn: () => Promise<Response>,
): Promise<Response> {
  const state: Record<string, unknown> = {}

  // Run all before interceptors
  for (const { before } of interceptors) {
    if (before) await before({ req, ctx, state })
  }

  // Run handler
  let response = await handlerFn()

  // Run all after interceptors in reverse order
  for (const { after } of [...interceptors].reverse()) {
    if (after) response = await after({ response, ctx, state })
  }

  return response
}
```

Example — timing interceptor:

```typescript
const timingInterceptor: InterceptorPair<any> = {
  before: ({ state }) => { state.start = performance.now() },
  after: ({ response, state }) => {
    const ms = performance.now() - (state.start as number)
    response.headers.set("X-Response-Time", `${ms.toFixed(2)}ms`)
    return response
  }
}
```

## Full Dispatch

```typescript
async function dispatch(
  req: Request,
  matched: MatchedRoute,
  container: DIContainer,
  errorHandlers: ErrorHandlerFn[],   // innermost first: route → router → global
): Promise<Response> {
  const { definition, params } = matched

  try {
    // 1. Build context via middleware chain
    const ctx = await runMiddlewarePipeline(req, definition.middlewares, container)

    // 2. Parse & validate input
    const input = await parseInput(req, definition, params)

    // 3. Run interceptors + handler
    const response = await runInterceptors(
      definition.interceptors,
      req,
      ctx,
      async () => {
        const raw = await definition.handler({ req, ctx, container, ...input })
        return coerceToResponse(raw, definition)
      }
    )

    return response

  } catch (err) {
    for (const handler of errorHandlers) {
      const result = await handler(err, { req })
      if (result != null) return result
    }
    // Should not reach here — built-in fallback always returns
    return defaultErrorHandler(err, { req })
  }
}

// Coerce plain object → Response.json() when output schema is defined
function coerceToResponse(raw: unknown, def: RouteDefinition): Response {
  if (raw instanceof Response) return raw
  if (def.outputSchema != null) return Response.json(raw)
  throw new TypeError("Handler must return a Response when no output schema is defined")
}
```

## Error Chain Assembly

The error handler list is built when walking the router tree, innermost first:

```typescript
// route-level catch → parent router onError → grandparent onError → built-in
const errorHandlers: ErrorHandlerFn[] = [
  ...(definition.errorHandler ? [definition.errorHandler] : []),
  ...routerErrorHandlers,   // collected bottom-up from router nesting
  defaultErrorHandler,
]
```

## Files to Create
- `core/compose.ts` — `runMiddlewarePipeline()`, `runInterceptors()`, `dispatch()`, `coerceToResponse()`
- `core/compose.test.ts` — ordering, error propagation, state sharing between interceptors, context merging
