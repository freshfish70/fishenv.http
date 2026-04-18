# 14 — OpenAPI Documentation Generation

## Decisions
- **Schema adapter**: Bundle a Valibot-to-JSON-Schema adapter. We're opinionated; users with other libs provide a custom adapter.
- **UI**: Serve JSON spec only. No Swagger/Scalar HTML.
- **OperationId**: Auto-generated from method + path (e.g. `post_api_users_id`); overridable via `.meta({ operationId })`.
- **Error types in `.output()`**: Documentation only — used to generate `responses` error entries in the spec.

## API

```typescript
import { generateOpenApi, serveOpenApi } from "@fishenv/http/openapi"

// Generate the spec object
const spec = generateOpenApi(router, {
  info: { title: "My API", version: "1.0.0" },
  servers: [{ url: "https://api.example.com" }],
})

// Serve as JSON at a path (registers a GET route on the router)
serveOpenApi(router, {
  path: "/openapi.json",
  info: { title: "My API", version: "1.0.0" },
})
```

## Schema Adapter Interface

```typescript
interface SchemaAdapter {
  toJsonSchema(schema: AnySchema): Record<string, unknown>
}

// Built-in Valibot adapter
const valibotAdapter: SchemaAdapter = {
  toJsonSchema(schema) {
    // Uses valibot-to-json-schema or custom implementation
    return toJsonSchema(schema)   // from jsr:@valibot/to-json-schema (if available)
  }
}
```

## `generateOpenApi()`

```typescript
interface OpenApiOptions {
  info: { title: string; version: string; description?: string }
  servers?: { url: string; description?: string }[]
  schemaAdapter?: SchemaAdapter   // default: valibotAdapter
}

function generateOpenApi(router: Router<any>, opts: OpenApiOptions): OpenApiSpec {
  const adapter = opts.schemaAdapter ?? valibotAdapter
  const routes = router.collectRoutes()   // all resolved routes
  const paths: Record<string, PathItemObject> = {}

  for (const route of routes) {
    const openApiPath = toOpenApiPath(route.fullPath)
    const method = route.method.toLowerCase()

    paths[openApiPath] ??= {}
    paths[openApiPath][method] = buildOperation(route, adapter)
  }

  return {
    openapi: "3.1.0",
    info: opts.info,
    servers: opts.servers,
    paths,
  }
}
```

## Path Conversion

```typescript
function toOpenApiPath(path: string): string {
  return path.replace(/:([^/]+)/g, "{$1}").replace(/\*/g, "{*}")
}
// "/users/:id/posts/:pid" → "/users/{id}/posts/{pid}"
```

## Operation Building

```typescript
function buildOperation(route: ResolvedRoute, adapter: SchemaAdapter): OperationObject {
  return {
    operationId: route.meta?.operationId ?? generateOperationId(route.method, route.fullPath),
    summary: route.meta?.title,
    description: route.meta?.description,
    tags: route.meta?.tags,
    deprecated: route.meta?.deprecated,
    parameters: buildParameters(route, adapter),
    requestBody: buildRequestBody(route, adapter),
    responses: buildResponses(route, adapter),
  }
}

function generateOperationId(method: string, path: string): string {
  const segments = path
    .replace(/^\//, "")
    .replace(/:([^/]+)/g, "$1")    // :id → id
    .replace(/\//g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "")
  return `${method.toLowerCase()}_${segments}`
  // e.g. "post_api_users_id"
}
```

## Parameters Building

```typescript
function buildParameters(route: ResolvedRoute, adapter: SchemaAdapter): ParameterObject[] {
  const params: ParameterObject[] = []

  // Path params
  for (const name of extractParamNames(route.fullPath)) {
    const schema = route.paramSchemas.get(name)
    params.push({
      name,
      in: "path",
      required: !route.fullPath.includes(`:${name}?`),
      schema: schema ? adapter.toJsonSchema(schema) : { type: "string" },
    })
  }

  // Query params (each property of query schema becomes a parameter)
  if (route.inputOptions?.query) {
    const jsonSchema = adapter.toJsonSchema(route.inputOptions.query) as any
    for (const [name, propSchema] of Object.entries(jsonSchema.properties ?? {})) {
      params.push({
        name,
        in: "query",
        required: jsonSchema.required?.includes(name) ?? false,
        schema: propSchema as Record<string, unknown>,
      })
    }
  }

  // Header params
  if (route.inputOptions?.headers) {
    const jsonSchema = adapter.toJsonSchema(route.inputOptions.headers) as any
    for (const [name, propSchema] of Object.entries(jsonSchema.properties ?? {})) {
      params.push({ name, in: "header", schema: propSchema as Record<string, unknown> })
    }
  }

  return params
}
```

## Request Body Building

```typescript
function buildRequestBody(route: ResolvedRoute, adapter: SchemaAdapter): RequestBodyObject | undefined {
  const { inputKind, inputOptions } = route
  if (inputKind === "none" || !inputOptions?.body) return undefined

  const contentTypeMap: Record<InputKind, string> = {
    json: "application/json",
    multipart: "multipart/form-data",
    urlencoded: "application/x-www-form-urlencoded",
    blob: "application/octet-stream",
    text: "text/plain",
    none: "",
  }

  return {
    required: true,
    content: {
      [contentTypeMap[inputKind]]: {
        schema: adapter.toJsonSchema(inputOptions.body),
      },
    },
  }
}
```

## Responses Building

```typescript
function buildResponses(route: ResolvedRoute, adapter: SchemaAdapter): ResponsesObject {
  const responses: ResponsesObject = {}

  // Success response
  if (route.outputSchema) {
    responses["200"] = {
      description: "Success",
      content: {
        "application/json": { schema: adapter.toJsonSchema(route.outputSchema) },
      },
    }
  } else {
    responses["200"] = { description: "Success" }
  }

  // Declared error types (documentation only)
  for (const ErrorCtor of route.errorTypes ?? []) {
    const instance = new ErrorCtor()
    const status = String(instance.status)
    responses[status] = {
      description: instance.message,
      content: {
        "application/json": {
          schema: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    }
  }

  return responses
}
```

## `serveOpenApi()`

```typescript
function serveOpenApi(
  router: Router<any>,
  opts: OpenApiOptions & { path?: string },
): void {
  const specPath = opts.path ?? "/openapi.json"
  router.get(specPath).handle(() => {
    const spec = generateOpenApi(router, opts)
    return Response.json(spec)
  })
}
```

## Files to Create
- `openapi/mod.ts` — `generateOpenApi()`, `serveOpenApi()`, `valibotAdapter`, all builders
- `openapi/openapi.test.ts` — spec shape, operationId generation, parameter extraction, error types

## Dependencies
- Valibot-to-JSON-Schema: check if `jsr:@valibot/to-json-schema` exists; if not, implement a thin converter for the types used in this framework (object, string, number, optional, array, union — the common subset).
