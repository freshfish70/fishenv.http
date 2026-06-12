# 09 — Request Context & Async Local Storage

## Decisions

- **ALS default**: Off. Enabled via `serve({ useAsyncLocalStorage: true })`.
- **ALS + DI**: fishenv.http provides the ALS store to the DI container when
  creating a request-scoped child. DI does not manage its own scoping
  independently.
- **`getCtx()` typing**: Typed wrapper pattern — users define their context
  shape once, cast once.
- **DI in v1**: Skipped. Container interface stub remains in types.

## Request Context (runtime)

The context object is assembled per-request as a plain object — not a class.
Handlers receive it as destructured args (see step 05). No separate "context
class" is exposed to users.

```typescript
// Internal per-request state carrier (not user-facing)
interface InternalRequestCtx {
  req: Request;
  middlewareCtx: Record<string, unknown>; // result of runMiddlewarePipeline
  container: DIContainer;
}
```

## Async Local Storage

When `useAsyncLocalStorage: true`, the full request context is stored in ALS for
the duration of the request. This enables access from anywhere in the call stack
without parameter threading.

```typescript
// core/als.ts

const _storage = new AsyncLocalStorage<Record<string, unknown>>();

// Called by dispatch() to wrap the entire request lifecycle
function runWithCtx<T>(
  ctx: Record<string, unknown>,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return _storage.run(ctx, fn);
}

// Access raw context from anywhere in the call stack
function getCtx(): Record<string, unknown> | undefined {
  return _storage.getStore();
}

// Typed wrapper pattern — users define their context shape once
function getCtxValue<T>(key: string): T | undefined {
  return _storage.getStore()?.[key] as T | undefined;
}
```

### Typed Wrapper Pattern

Users create a thin typed wrapper in their app:

```typescript
// app/ctx.ts
import { getCtxValue } from "@fishenv/http";

interface AppCtx {
  user: User;
  requestId: string;
}

// One cast, one place — all callers are type-safe
export const ctx = {
  get user(): User {
    return getCtxValue<User>("user")!;
  },
  get requestId(): string {
    return getCtxValue<string>("requestId")!;
  },
};

// Usage in a service (no parameter threading needed)
import { ctx } from "./ctx.ts";

class UserRepository {
  async findCurrentUser() {
    return this.db.find(ctx.user.id);
  }
}
```

## ALS Integration in dispatch()

```typescript
// core/compose.ts — inside dispatch()

if (options.useAsyncLocalStorage) {
  return runWithCtx({ req, ...middlewareCtx }, () => runRouteHandler(...))
} else {
  return runRouteHandler(...)
}
```

## ALS + DI Container (future wiring)

When DI is added (v2+), the request-scoped container child should be created
inside `runWithCtx` so that services can call `getCtxValue()`:

```typescript
// Future — when DI is implemented:
const requestContainer = container.createRequestScope()
return runWithCtx({ req, ...middlewareCtx, container: requestContainer }, () => ...)
```

For v1, since DI is skipped, this wiring is not implemented — just documented
here.

## Files to Create

- `core/als.ts` — `runWithCtx()`, `getCtx()`, `getCtxValue()`
- Modify `core/compose.ts` — call `runWithCtx` in dispatch when ALS is enabled
- `core/als.test.ts` — verify store is available mid-request, not available
  between requests
