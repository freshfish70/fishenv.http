# 08 — Error Handling

## Decisions

- **Logger**: `serve({ logger })` option; falls back to `console.error`.
- **Development mode**: Stack traces in responses only when
  `serve({ development: true })`.
- **Error types in `.output()`**: Documentation / OpenAPI only — no runtime
  enforcement.
- **Error distinction**: Middleware throws typed `HttpError` subclasses; error
  handlers inspect with `instanceof`.

## Error Class Hierarchy

```typescript
// core/error.ts

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = "HttpError"
  }

  toResponse(development = false): Response {
    const body: Record<string, unknown> = { error: this.message }
    if (development && this.stack) body.stack = this.stack
    return Response.json(body, { status: this.status })
  }
}

// Pre-defined subclasses
class BadRequestError extends HttpError {
  constructor(message = "Bad Request", cause?: unknown) { super(400, message, cause) }
}
class UnauthorizedError extends HttpError {
  constructor(message = "Unauthorized") { super(401, message) }
}
class ForbiddenError extends HttpError {
  constructor(message = "Forbidden") { super(403, message) }
}
class NotFoundError extends HttpError {
  constructor(message = "Not Found") { super(404, message) }
}
class MethodNotAllowedError extends HttpError {
  constructor(message = "Method Not Allowed") { super(405, message) }
}
class ConflictError extends HttpError {
  constructor(message = "Conflict", cause?: unknown) { super(409, message, cause) }
}
class UnprocessableEntityError extends HttpError {
  constructor(message = "Unprocessable Entity", cause?: unknown) { super(422, message, cause) }
}
class TooManyRequestsError extends HttpError {
  constructor(message = "Too Many Requests") { super(429, message) }
}
class InternalServerError extends HttpError {
  constructor(message = "Internal Server Error", cause?: unknown) { super(500, message, cause) }
}

// See 07-request-parsing.md
class ValidationError extends BadRequestError { ... }
```

## Default Handlers

```typescript
function defaultErrorHandler(
  err: unknown,
  { req }: { req: Request },
  opts: { development?: boolean; logger?: Logger },
): Response {
  if (err instanceof HttpError) {
    return err.toResponse(opts.development);
  }
  const logger = opts.logger ?? console;
  logger.error("[fishenv.http] Unhandled error:", err);
  const body: Record<string, unknown> = { error: "Internal Server Error" };
  if (opts.development && err instanceof Error) body.stack = err.stack;
  return Response.json(body, { status: 500 });
}

function defaultNotFoundHandler(req: Request): Response {
  return Response.json(
    { error: "Not Found", path: new URL(req.url).pathname },
    { status: 404 },
  );
}

function defaultMethodNotAllowedHandler(
  req: Request,
  allowed: HttpMethod[],
): Response {
  return new Response(null, {
    status: 405,
    headers: { Allow: allowed.join(", ") },
  });
}
```

## Error Handler Chain

Error handlers are typed as:

```typescript
type ErrorHandlerFn = (
  err: unknown,
  args: { req: Request },
) => Response | Promise<Response> | null | undefined | void;
```

Returning `null | undefined | void` passes to the next handler. The built-in
fallback always returns a `Response`.

The chain is assembled per-route during `build()` (see step 06), innermost
first:

```
route.catch(fn)
router.onError(fn)        // parent router
router.onError(fn)        // grandparent router (if nested)
defaultErrorHandler       // always last
```

## Error Handler Usage Example

```typescript
// Middleware-level: throw typed errors
const authMiddleware: MiddlewareFn<{}, { user: User }> = async ({ req }) => {
  const token = req.headers.get("authorization")
  if (!token) throw new UnauthorizedError()
  return { user: await verifyToken(token) }
}

// Router-level: handle all errors in the router tree
api.onError((err, { req }) => {
  if (err instanceof HttpError) return err.toResponse()
  // return nothing → passes to default handler
})

// Route-level: handle errors for this specific route
router.post("/upload")
  .handle(...)
  .catch((err, { req }) => {
    if (err instanceof ValidationError) {
      return Response.json({ validationErrors: err.issues }, { status: 400 })
    }
    // return nothing → passes up the chain
  })
```

## Files to Create

- `core/error.ts` — all error classes + default handlers
- `core/error.test.ts` — error chain propagation, `toResponse()`, development
  mode stack traces
