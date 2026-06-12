# 15 — RPC Client Generation

## Decisions

- **fishenv.wrq**: Exists at `jsr:@fishenv/wrq` — a thin fetch wrapper with
  request/response hooks.
- **Approach**: Runtime client only for v1 (same codebase / monorepo). Wrq
  handles auth via its own hook system.
- **Client-side validation**: Opt-in via `validate: true`.
- **Auth**: Delegate to wrq's request hooks (`onRequest`). No separate auth
  config on the client.

## API

```typescript
import { createClient } from "@fishenv/http/client-gen";
import type { api } from "./server.ts";

const client = createClient<typeof api>({
  baseUrl: "https://api.example.com",
  validate: true, // validate request bodies against shared schemas before sending
  // Auth via wrq hooks:
  hooks: {
    onRequest: (req) => {
      req.headers.set("Authorization", `Bearer ${getToken()}`);
      return req;
    },
  },
});

// Fully typed from the router definition
const user = await client.post("/api/users").body({
  name: "Alice",
  email: "alice@example.com",
}).send();
//     ^? User — inferred from .output(UserSchema)

const users = await client.get("/api/users").query({ page: 1 }).send();
//     ^? User[] — inferred
```

## Type-Level Client Inference

The client type is derived entirely from the router's type:

```typescript
// Infer all routes from a Router type
type RouterRoutes<R> = R extends Router<any> ? CollectRoutes<R> : never;

// For each route: map method+path → { input, output }
type ClientShape<R extends Router<any>> = {
  [Method in HttpMethod as Lowercase<Method>]: <
    P extends PathsForMethod<R, Method>,
  >(
    path: P,
  ) => RequestBuilder<
    InferRouteInput<R, Method, P>,
    InferRouteOutput<R, Method, P>
  >;
};

interface RequestBuilder<Input, Output> {
  body(data: InferBody<Input>): this;
  query(params: InferQuery<Input>): this;
  headers(headers: Record<string, string>): this;
  send(): Promise<Output>;
}
```

## Runtime Client

```typescript
// client-gen/mod.ts

import { WrqClient } from "@fishenv/wrq";

interface ClientOptions {
  baseUrl: string;
  validate?: boolean; // default: false
  hooks?: WrqHooks;
}

function createClient<R extends Router<any>>(
  opts: ClientOptions,
): ClientShape<R> {
  const wrq = new WrqClient({ baseUrl: opts.baseUrl, hooks: opts.hooks });

  return new Proxy({} as ClientShape<R>, {
    get(_, method: string) {
      return (path: string) =>
        new RequestBuilder(wrq, method.toUpperCase(), path, opts);
    },
  });
}

class RequestBuilder<Input, Output> {
  #body?: unknown;
  #query?: Record<string, unknown>;
  #headers?: Record<string, string>;

  constructor(
    private wrq: WrqClient,
    private method: string,
    private path: string,
    private opts: ClientOptions,
  ) {}

  body(data: unknown): this {
    this.#body = data;
    return this;
  }
  query(params: Record<string, unknown>): this {
    this.#query = params;
    return this;
  }
  headers(headers: Record<string, string>): this {
    this.#headers = headers;
    return this;
  }

  async send(): Promise<Output> {
    // Optional client-side validation
    if (this.opts.validate && this.#body != null) {
      const schema = getRouteBodySchema(this.method, this.path);
      if (schema) validateBodyOrThrow(schema, this.#body);
    }

    // Build URL with query params
    const url = new URL(this.path, this.wrq.baseUrl);
    if (this.#query) {
      for (const [k, v] of Object.entries(this.#query)) {
        if (v != null) url.searchParams.set(k, String(v));
      }
    }

    const result = await this.wrq.request({
      method: this.method,
      url: url.toString(),
      body: this.#body,
      headers: this.#headers,
    });

    if (!result.ok) {
      throw new ClientError(result.status, await result.json());
    }

    return result.json() as Output;
  }
}
```

## Schema Access for Validation

For client-side validation to work, the route schemas must be accessible at
runtime on the client side. This requires that the router definition is
importable in the client environment (monorepo/shared code):

```typescript
// Internal: extract body schema for a given method+path from a router
function getRouteBodySchema(
  method: string,
  path: string,
): AnySchema | undefined {
  // Walk the router's route registry (available since it's the same import)
  return routeRegistry.get(`${method}:${path}`)?.inputOptions?.body;
}
```

This only works for the runtime client pattern (shared router import). Code-gen
clients are out of scope for v1.

## `ClientError`

```typescript
class ClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`HTTP ${status}`);
    this.name = "ClientError";
  }
}
```

## Files to Create

- `client-gen/mod.ts` — `createClient()`, `RequestBuilder`, `ClientError`
- `client-gen/client.test.ts` — typed inference tests, validation opt-in, query
  building

## Dependencies

- `jsr:@fishenv/wrq` — HTTP client with hooks
