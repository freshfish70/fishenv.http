# 07 — Request Parsing & Input Validation

## Decisions

- **FormData**: Pass `FormData` directly to the Valibot schema — no
  auto-coercion to plain object.
- **Bracket notation**: Not supported. Flat keys only; recommend JSON for nested
  data.
- **Header normalization**: All header names lowercased before validation.
- **Validation errors**: Throw `ValidationError extends HttpError(400)` with
  Valibot issues attached.

## Parsing Pipeline

```
Request
  → parse cookies (from Cookie header)
  → extract headers (lowercased keys)
  → extract query params (URLSearchParams)
  → parse body (based on InputKind)
  → validate each part against its schema (Valibot)
  → validate path params (raw strings) against .param() schemas
  → return typed { body, headers, query, cookies, path }
```

## `core/request.ts`

```typescript
interface ParsedInput {
  body: unknown;
  headers: Record<string, string>;
  query: Record<string, string | string[]>;
  cookies: Record<string, string>;
  path: Record<string, unknown>; // after .param() validation (may include coerced types)
}

async function parseInput(
  req: Request,
  def: RouteDefinition,
  rawParams: Record<string, string>,
): Promise<ParsedInput>;
```

### Body Parsing by Kind

```typescript
async function parseBody(
  req: Request,
  kind: InputKind,
  opts: InputOptions<InputKind>,
): Promise<unknown> {
  switch (kind) {
    case "json":
      try {
        return await req.json();
      } catch (e) {
        throw new BadRequestError("Invalid JSON", e);
      }

    case "multipart":
    case "urlencoded":
      if (opts.maxSize) enforceMaxSize(req, opts.maxSize);
      return req.formData(); // returns FormData — passed directly to schema

    case "blob":
      if (opts.maxSize) enforceMaxSize(req, opts.maxSize);
      return req.blob();

    case "text":
      return req.text();

    case "none":
    default:
      return undefined;
  }
}

function enforceMaxSize(req: Request, maxSize: number): void {
  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength) > maxSize) {
    throw new HttpError(413, "Payload Too Large");
  }
  // Note: content-length may be absent. Actual stream size checked after reading.
}
```

### Header Extraction (lowercase)

```typescript
function extractHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value; // Headers API already lowercases keys
  });
  return headers;
}
```

### Cookie Parsing

```typescript
function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.get("cookie") ?? "";
  if (!header) return {};
  return Object.fromEntries(
    header.split(";")
      .map((pair) => pair.trim().split("="))
      .filter(([k]) => k?.length > 0)
      .map(([k, ...v]) => [k.trim(), decodeURIComponent(v.join("="))]),
  );
}
```

### Query Extraction

```typescript
function extractQuery(req: Request): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = {};
  new URL(req.url).searchParams.forEach((value, key) => {
    const existing = params[key];
    if (existing === undefined) {
      params[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      params[key] = [existing, value];
    }
  });
  return params;
}
```

## `core/validation.ts`

```typescript
import * as v from "valibot";

async function validateField<S extends AnySchema>(
  schema: S,
  value: unknown,
  field: "body" | "headers" | "query" | "cookies" | "path",
): Promise<v.InferOutput<S>> {
  const result = v.safeParse(schema, value);
  if (!result.success) {
    throw new ValidationError(field, result.issues);
  }
  return result.output;
}

// Path params: validate each param that has a schema; leave others as raw string
async function validatePathParams(
  rawParams: Record<string, string>,
  schemas: Map<string, AnySchema>,
): Promise<Record<string, unknown>> {
  const validated: Record<string, unknown> = { ...rawParams };
  for (const [name, schema] of schemas) {
    validated[name] = await validateField(schema, rawParams[name], "path");
  }
  return validated;
}
```

## ValidationError Shape

```typescript
// core/error.ts

class ValidationError extends HttpError {
  constructor(
    public readonly field: "body" | "headers" | "query" | "cookies" | "path",
    public readonly issues: v.BaseIssue<unknown>[],
  ) {
    super(400, "Validation Error");
    this.name = "ValidationError";
  }

  toResponse(): Response {
    return Response.json({
      error: "ValidationError",
      field: this.field,
      issues: this.issues.map((i) => ({
        message: i.message,
        path: i.path?.map((p) => p.key) ?? [],
      })),
    }, { status: 400 });
  }
}
```

## Files to Create

- `core/request.ts` — `parseInput()`, `parseBody()`, `parseCookies()`,
  `extractHeaders()`, `extractQuery()`
- `core/validation.ts` — `validateField()`, `validatePathParams()`
- `core/request.test.ts` — all input kinds, header normalization, cookie
  parsing, maxSize enforcement, validation errors
