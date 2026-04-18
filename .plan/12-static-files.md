# 12 — Static File Serving

## Decisions
- **Location**: `@fishenv/http/static` sub-path.
- **Extension pattern**: Mixin function `withStatic(router, prefix, opts)`.
- **Range requests**: Not supported in v1.
- **Pre-compressed files**: Serve `.gz` / `.br` variants automatically when `Accept-Encoding` matches.
- **Security headers**: Add `X-Content-Type-Options: nosniff` and `Cache-Control: no-cache` by default; user can override.
- **Directory listing**: `true | "html" | "json"` — default `false`.

## Extension Pattern

```typescript
import { r, serve } from "@fishenv/http"
import { withStatic } from "@fishenv/http/static"

const api = r({ prefix: "/api" })
const appRouter = withStatic(api, "/assets", {
  directory: "./public",
  cacheControl: "max-age=3600",
  directoryListing: false,
  index: "index.html",
  dotFiles: false,
})

serve(appRouter, { port: 8080 })
```

## StaticOptions

```typescript
interface StaticOptions {
  directory: string               // required — path on disk to serve from
  cacheControl?: string           // default: "no-cache"
  directoryListing?: boolean | "html" | "json"   // default: false
  index?: string                  // filename to serve for directory requests (e.g. "index.html")
  dotFiles?: boolean              // serve files starting with "." (default: false)
}
```

## `withStatic()` Implementation

Registers a wildcard `GET` route `${prefix}/*` on the router:

```typescript
function withStatic<Ctx extends Record<string, unknown>>(
  router: Router<Ctx>,
  prefix: string,
  opts: StaticOptions,
): Router<Ctx> {
  const absRoot = path.resolve(opts.directory)

  router.get(`${prefix}/*`).handle(async ({ path: params }) => {
    const relativePath = (params["*"] ?? "") as string
    return serveStaticFile(req, absRoot, relativePath, opts)
  })

  return router
}
```

## `serveStaticFile()`

### Security: Path Traversal Prevention

```typescript
function resolveSafePath(root: string, relative: string): string | null {
  const resolved = path.resolve(root, relative.replace(/^\/+/, ""))
  return resolved.startsWith(root) ? resolved : null   // null = traversal attempt
}
```

### File Serving Flow

```typescript
async function serveStaticFile(
  req: Request,
  root: string,
  relative: string,
  opts: StaticOptions,
): Promise<Response> {
  // Security check
  const filePath = resolveSafePath(root, relative)
  if (!filePath) return new Response(null, { status: 403 })

  // Dot-file check
  if (!opts.dotFiles && path.basename(filePath).startsWith(".")) {
    return new Response(null, { status: 403 })
  }

  let stat: Deno.FileInfo
  try { stat = await Deno.stat(filePath) }
  catch { return new Response(null, { status: 404 }) }

  if (stat.isDirectory) {
    if (opts.index) {
      return serveStaticFile(req, root, path.join(relative, opts.index), opts)
    }
    if (opts.directoryListing) {
      return serveDirectoryListing(filePath, opts.directoryListing)
    }
    return new Response(null, { status: 403 })
  }

  // ETag (mtime + size)
  const etag = `"${stat.mtime?.getTime() ?? 0}-${stat.size}"`
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304 })
  }

  // Pre-compressed file selection
  const acceptEncoding = req.headers.get("accept-encoding") ?? ""
  const { resolvedPath, encoding } = await resolveCompressed(filePath, acceptEncoding)

  const mime = contentType(path.extname(filePath)) ?? "application/octet-stream"
  const headers = new Headers({
    "Content-Type": mime,
    "ETag": etag,
    "Cache-Control": opts.cacheControl ?? "no-cache",
    "X-Content-Type-Options": "nosniff",
  })
  if (encoding) headers.set("Content-Encoding", encoding)

  const file = await Deno.open(resolvedPath, { read: true })
  return new Response(file.readable, { headers })
}
```

### Pre-compressed File Resolution

```typescript
async function resolveCompressed(
  filePath: string,
  acceptEncoding: string,
): Promise<{ resolvedPath: string; encoding?: string }> {
  if (acceptEncoding.includes("br")) {
    try {
      await Deno.stat(filePath + ".br")
      return { resolvedPath: filePath + ".br", encoding: "br" }
    } catch { /* not found */ }
  }
  if (acceptEncoding.includes("gzip")) {
    try {
      await Deno.stat(filePath + ".gz")
      return { resolvedPath: filePath + ".gz", encoding: "gzip" }
    } catch { /* not found */ }
  }
  return { resolvedPath: filePath }
}
```

### Directory Listing

```typescript
async function serveDirectoryListing(
  dirPath: string,
  format: true | "html" | "json",
): Promise<Response> {
  const entries: Deno.DirEntry[] = []
  for await (const entry of Deno.readDir(dirPath)) {
    entries.push(entry)
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))

  if (format === "json") {
    return Response.json(entries.map(e => ({ name: e.name, isDirectory: e.isDirectory })))
  }

  // HTML listing (format === true || "html")
  const items = entries
    .map(e => `<li><a href="${e.name}${e.isDirectory ? "/" : ""}">${e.name}</a></li>`)
    .join("\n")
  return new Response(
    `<!DOCTYPE html><html><body><ul>\n${items}\n</ul></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  )
}
```

## Files to Create
- `static/mod.ts` — `withStatic()`, `serveStaticFile()`, `resolveSafePath()`, `resolveCompressed()`, `serveDirectoryListing()`
- `static/static.test.ts` — path traversal blocked, dot-file blocking, pre-compressed serving, ETag 304, directory listing HTML/JSON

## Dependencies
- `jsr:@std/path` — path manipulation
- `jsr:@std/media-types` — `contentType()` for MIME detection
