# 02 — Core TypeScript Types

## Decisions
- **Validation**: Valibot. Core defines its own `ValibotSchema<O>` alias; do not depend on `@standard-schema/spec`. Design types so they can be made Standard Schema-compatible later without breaking changes.
- **Path params**: Auto-inferred as `string` from the path pattern. `.param()` narrows/coerces specific params.
- **DIContainer**: Minimal interface — `get<T>(token)` only. No implementation in v1.
- **Handler return**: With `.output()` defined → plain object auto-serialized as JSON. Without `.output()` → must return `Response`.
- **Interceptor shared state**: Before/after interceptor functions share state via a closure object passed to both — the RouteBuilder carries separate `BeforeCtx` and `AfterCtx` type params.

## Schema Type (Valibot-based, Standard Schema-compatible shape)

```typescript
// core/types.ts

import type * as v from "valibot"

// Alias for any Valibot schema with a known output type
type ValibotSchema<O = unknown> = v.BaseSchema<unknown, O, v.BaseIssue<unknown>>

// Used everywhere a schema is expected
type AnySchema = ValibotSchema<unknown>

type InferOutput<S extends AnySchema> = v.InferOutput<S>
```

## Input Schema

```typescript
type InputKind = "json" | "multipart" | "urlencoded" | "blob" | "text" | "none"

interface InputOptions<K extends InputKind> {
  body?: K extends "blob" | "text" ? never : AnySchema
  headers?: AnySchema
  query?: AnySchema
  cookies?: AnySchema
  maxSize?: K extends "blob" | "multipart" ? number : never
}

interface ResolvedInput<K extends InputKind, O extends InputOptions<K>> {
  kind: K
  options: O
}

// Inferred handler arg types
type InferBody<K extends InputKind, O extends InputOptions<K>> =
  K extends "blob" ? Blob
  : K extends "text" ? string
  : K extends "none" ? undefined
  : O["body"] extends AnySchema ? InferOutput<O["body"]>
  : K extends "multipart" | "urlencoded" ? FormData
  : unknown

type InferHeaders<O extends InputOptions<InputKind>> =
  O["headers"] extends AnySchema ? InferOutput<O["headers"]> : Record<string, string>

type InferQuery<O extends InputOptions<InputKind>> =
  O["query"] extends AnySchema ? InferOutput<O["query"]> : Record<string, string | string[]>

type InferCookies<O extends InputOptions<InputKind>> =
  O["cookies"] extends AnySchema ? InferOutput<O["cookies"]> : Record<string, string>
```

## Path Param Extraction

```typescript
// Extracts param names from a path pattern string at the type level
type ExtractParams<P extends string> =
  P extends `${string}:${infer Param}/${infer Rest}`
    ? Param extends `${infer Name}?` ? Name : Param | ExtractParams<`/${Rest}`>
    : P extends `${string}:${infer Param}`
      ? Param extends `${infer Name}?` ? Name : Param
      : never

// Base path params: all auto-inferred as string
type BasePathParams<P extends string> = {
  [K in ExtractParams<P>]: string
} & (P extends `${string}*` ? { "*": string } : unknown)

// After .param() overrides: merge in narrowed/coerced types
type MergeParam<
  Base extends Record<string, unknown>,
  Name extends string,
  Schema extends AnySchema,
> = Omit<Base, Name> & Record<Name, InferOutput<Schema>>
```

## Middleware Types

```typescript
// Middleware receives accumulated ctx, returns new fields to merge into ctx
type MiddlewareFn<In extends Record<string, unknown>, Out extends Record<string, unknown>> =
  (ctx: In & { req: Request }) => Promise<Out> | Out

// Merge accumulated ctx: router middleware + route middleware
type MergeCtx<A extends Record<string, unknown>, B extends Record<string, unknown>> = A & B
```

## Interceptor Types (with shared state)

Before and after interceptors share a mutable state object created per-request:

```typescript
// State created once, passed to both before and after functions
type InterceptorState = Record<string, unknown>

type BeforeInterceptorFn<Ctx extends Record<string, unknown>> = (
  args: { req: Request; ctx: Ctx; state: InterceptorState }
) => Promise<void> | void

type AfterInterceptorFn<Ctx extends Record<string, unknown>> = (
  args: { response: Response; ctx: Ctx; state: InterceptorState }
) => Promise<Response> | Response

interface InterceptorPair<Ctx extends Record<string, unknown>> {
  before?: BeforeInterceptorFn<Ctx>
  after?: AfterInterceptorFn<Ctx>
}
```

## Handler Types

```typescript
interface HandlerArgs<
  Ctx extends Record<string, unknown>,
  K extends InputKind,
  O extends InputOptions<K>,
  Params extends Record<string, unknown>,
> {
  req: Request
  path: Params
  ctx: Ctx
  body: InferBody<K, O>
  headers: InferHeaders<O>
  query: InferQuery<O>
  cookies: InferCookies<O>
  container: DIContainer
}

// With output schema: can return plain object or Response
type HandlerFn<Ctx, K extends InputKind, O extends InputOptions<K>, Params, Output> = (
  args: HandlerArgs<Ctx, K, O, Params>
) => Output extends unknown
  ? Response | Promise<Response>
  : Response | Output | Promise<Response | Output>

type ErrorHandlerFn = (
  err: unknown,
  args: { req: Request }
) => Response | Promise<Response> | null | undefined | void
```

## Route Definition (internal registry)

```typescript
interface RouteDefinition {
  method: HttpMethod
  path: string                                  // full path incl. prefix
  middlewares: MiddlewareFn<any, any>[]
  paramSchemas: Map<string, AnySchema>
  inputKind: InputKind
  inputOptions: InputOptions<InputKind>
  outputSchema?: AnySchema
  errorTypes?: (new (...args: any[]) => HttpError)[]
  meta?: RouteMeta
  interceptors: InterceptorPair<any>[]
  handler: HandlerFn<any, any, any, any, any>
  errorHandler?: ErrorHandlerFn
  kind: "http"                                  // vs "ws", "sse" in extensions
}
```

## DIContainer Interface (minimal, v1)

```typescript
interface DIContainer {
  get<T>(token: abstract new (...args: any[]) => T): T
}
```

## Supporting Types

```typescript
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD"

interface RouteMeta {
  title?: string
  description?: string
  tags?: string[]
  deprecated?: boolean
  operationId?: string      // override for OpenAPI; auto-generated if omitted
}

type NotFoundHandler = (req: Request) => Response | Promise<Response>
```

## Files to Create
- `core/types.ts` — all types above
- `core/types.test.ts` — compile-time type tests using `@std/testing` `assertType`
