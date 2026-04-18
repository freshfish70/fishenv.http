# 13 — Dependency Injection Integration

## Decision: Skipped for v1

DI implementation (`fishenv.di`) is deferred entirely. The `di/` directory will contain only stubs and the interface contract.

## What v1 Ships

### `DIContainer` interface in `core/types.ts`

```typescript
interface DIContainer {
  get<T>(token: abstract new (...args: any[]) => T): T
}
```

This is the only contract the core depends on. Handlers receive `container: DIContainer` in their args; if no container is passed to `serve()`, a no-op container is used.

### No-op Container (for use when no DI is configured)

```typescript
// core/types.ts or core/router.ts

const noopContainer: DIContainer = {
  get(token) {
    throw new Error(
      `No DI container configured. Pass a container to serve({ container }) to use container.get(${token.name}).`
    )
  }
}
```

### `di/mod.ts` stub

```typescript
// di/mod.ts — placeholder for future implementation
export type { DIContainer } from "../core/types.ts"

// TODO: implement Container class for v2
```

## Future Design (documented for reference)

When implemented, the design decisions are:

- **API**: Explicit `.bind(Token, factory, scope)` — no decorators for v1 of DI.
- **Scopes**: `singleton` | `transient` | `request`.
- **Request scope**: Container creates a child scope per request via `container.createRequestScope()`. Wired in `dispatch()` before running middleware.
- **ALS wiring**: fishenv.http provides the ALS store to the request-scoped container so services can call `getCtxValue()`.
- **Disposal**: `[Symbol.asyncDispose]()` on the request-scoped container; called after response is sent.
- **Package**: `@fishenv/http/di` sub-path (not a separate package).

## Files to Create
- `di/mod.ts` — stub + `DIContainer` re-export
- `core/types.ts` — `DIContainer` interface + `noopContainer`
