# 03 — Path Matching Engine

## Decisions
- **Case sensitivity**: Always case-sensitive. No option to disable.
- **Wildcard key**: Captured as `path["*"]`.
- **Build strategy**: Explicit `.build()` call compiles all patterns; no lazy compilation.

## Interface

```typescript
interface MatchedRoute {
  definition: RouteDefinition
  params: Record<string, string>    // raw string values, pre-schema validation
  allowedMethods?: HttpMethod[]     // populated on 405 for the same path
}

interface RouterMatcher {
  add(method: HttpMethod | "ALL", path: string, def: RouteDefinition): void
  match(method: string, path: string): MatchedRoute | null
  compile(): void                   // called once before first request
}
```

## Path Pattern Rules

| Pattern | Example match | `path` result |
|---------|--------------|---------------|
| `/users` | `/users` | `{}` |
| `/users/:id` | `/users/123` | `{ id: "123" }` |
| `/users/:id?` | `/users` or `/users/123` | `{}` or `{ id: "123" }` |
| `/files/*` | `/files/a/b/c` | `{ "*": "a/b/c" }` |
| `/a/:x/b/:y` | `/a/1/b/2` | `{ x: "1", y: "2" }` |

## Implementation

### `core/utils/url.ts`

```typescript
// Combine a base prefix and a route sub-path into one canonical path
function mergePaths(base: string, sub: string): string

// Extract all named param names from a pattern (runtime, not type-level)
function extractParamNames(pattern: string): string[]

// Convert a route pattern to a regex + ordered param name list
function buildRouteRegex(pattern: string): { regex: RegExp; paramNames: string[] }
// e.g. "/users/:id/posts/:pid" → { regex: /^\/users\/([^/]+)\/posts\/([^/]+)$/, paramNames: ["id", "pid"] }
// "/files/*" → { regex: /^\/files\/(.*)$/, paramNames: ["*"] }
```

### `core/matcher.ts`

Compilation strategy:
1. Group routes by HTTP method (plus an ALL bucket for method-agnostic matching)
2. Per group, sort: static paths first, then parameterized by specificity (fewest wildcards = higher priority)
3. Build a `Map<string, RouteDefinition>` for exact static paths (O(1) lookup)
4. Build an array of `{ regex, paramNames, def }` for dynamic paths (scanned in order)
5. On `match()`: check static map first, then scan dynamic array

```typescript
interface CompiledRoute {
  regex: RegExp
  paramNames: string[]
  definition: RouteDefinition
}

class Matcher implements RouterMatcher {
  #rawRoutes: Array<{ method: string; path: string; def: RouteDefinition }> = []
  #compiled = false

  // Per method: static map + dynamic list
  #staticRoutes = new Map<string, Map<string, RouteDefinition>>()   // method → path → def
  #dynamicRoutes = new Map<string, CompiledRoute[]>()               // method → sorted compiled

  add(method, path, def): void {
    if (this.#compiled) throw new Error("Cannot add routes after compile()")
    this.#rawRoutes.push({ method: method.toUpperCase(), path, def })
  }

  compile(): void {
    for (const { method, path, def } of this.#rawRoutes) {
      if (!path.includes(":") && !path.includes("*")) {
        // Static path
        if (!this.#staticRoutes.has(method)) this.#staticRoutes.set(method, new Map())
        this.#staticRoutes.get(method)!.set(path, def)
      } else {
        // Dynamic path
        const { regex, paramNames } = buildRouteRegex(path)
        const compiled: CompiledRoute = { regex, paramNames, def }
        if (!this.#dynamicRoutes.has(method)) this.#dynamicRoutes.set(method, [])
        this.#dynamicRoutes.get(method)!.push(compiled)
      }
    }
    // Sort dynamic routes: fewer wildcards and more static segments = higher priority
    for (const list of this.#dynamicRoutes.values()) {
      list.sort((a, b) => specificity(b.def.path) - specificity(a.def.path))
    }
    this.#compiled = true
  }

  match(method: string, path: string): MatchedRoute | null {
    method = method.toUpperCase()

    // Check static
    const def = this.#staticRoutes.get(method)?.get(path)
      ?? this.#staticRoutes.get("ALL")?.get(path)
    if (def) return { definition: def, params: {} }

    // Check dynamic
    for (const route of [...(this.#dynamicRoutes.get(method) ?? []), ...(this.#dynamicRoutes.get("ALL") ?? [])]) {
      const match = route.regex.exec(path)
      if (match) {
        const params: Record<string, string> = {}
        route.paramNames.forEach((name, i) => { params[name] = match[i + 1] })
        return { definition: route.def, params }
      }
    }

    // 405: check if ANY method matches this path
    const allowed = this.#findAllowedMethods(path)
    if (allowed.length > 0) return { definition: null!, params: {}, allowedMethods: allowed }

    return null
  }
}

// Score: more static segments = higher, wildcards = lower
function specificity(path: string): number {
  return path.split("/").reduce((score, seg) =>
    score + (seg.startsWith(":") ? 1 : seg === "*" ? 0 : 2), 0)
}
```

## HEAD Auto-Handling

`match()` is called with the actual method. For `HEAD`, the matcher first tries `HEAD`-registered routes, then falls back to finding the `GET` match for the same path. The caller (`dispatch`) strips the body before returning.

```typescript
// In dispatch():
if (method === "HEAD") {
  const result = matcher.match("HEAD", path) ?? matcher.match("GET", path)
  if (result) {
    const response = await runRoute(result)
    return new Response(null, { status: response.status, headers: response.headers })
  }
}
```

## Files to Create
- `core/utils/url.ts` — `mergePaths()`, `extractParamNames()`, `buildRouteRegex()`
- `core/matcher.ts` — `Matcher` class
- `core/matcher.test.ts` — tests for all pattern types, priority ordering, HEAD fallback, 405 detection
