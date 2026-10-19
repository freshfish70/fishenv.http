# 12 — Static File Serving (`@fishenv/http/static`)

> Revision 2. This replaces the Deno-era draft. The runtime is now Bun, and the
> security model has been rewritten from scratch. Decisions that changed from
> v1 of this plan are marked **(changed)**.

## Goal

Authors should be able to serve a directory without writing any path handling,
traversal checks, MIME detection, caching or negotiation code themselves.
The safe configuration is the default one. Anything that weakens it needs an
explicit, greppable option.

## Decisions

| Topic                | Decision                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| Location             | `@fishenv/http/static` sub-path export                                                            |
| Primary API          | **(changed)** `staticFiles(opts)` returns a mountable `Router`, used as `app.add("/assets", files)` |
| Mixin                | `withStatic(router, prefix, opts)` stays as thin sugar over `router.add(prefix, staticFiles(opts))` |
| Single-file helper   | `serveFile(req, absPath, opts?)` for handlers that serve one known file                             |
| Methods              | `GET` only. `HEAD` comes from the router's existing GET fallback and body stripping                 |
| Range requests       | **(changed)** Supported for free: Bun applies single-range `Range`/`If-Range` to `Bun.file` bodies (verified on 1.4.3, including through the CORS re-wrap). We test it but add no code |
| Multi-range          | Not supported. Bun ignores it and returns 200, which is safe                                      |
| Pre-compressed       | `.br` / `.gz` siblings, chosen by parsing `Accept-Encoding` q-values, with `Vary: Accept-Encoding` |
| MIME                 | `Bun.file(path).type`. No dependency                                                              |
| Default headers      | `X-Content-Type-Options: nosniff`, `Cache-Control: no-cache`, `ETag`, `Last-Modified`              |
| Dotfiles             | Hidden (404) by default, for **any** path segment, not only the basename                           |
| Symlinks             | Followed only while the real path stays inside the root                                            |
| Directory listing    | **(changed)** Deferred to v1.1 (Q-S4)                                                              |
| SPA fallback         | In v1 (Q-S5). See "SPA fallback"                                                                    |
| Lookup cache         | In v1, opt-in (Q-S6). See "Lookup cache"                                                            |
| Rest param syntax    | `:path*` in core (Q-S2). It extends the existing `:name` / `:name?` syntax and matches path-to-regexp and Express 4 |
| Error responses      | `400` only when `%`-decoding fails. Every other rejection is a plain `404` with no filesystem detail, so there is no existence oracle (Q-S3) |

## Why a mountable Router instead of a mixin

`withSse` is a mixin because it adds a new *method* (`.sse()`). Static serving
adds no method. It is just a set of routes, so it fits the existing
`.add()` composition:

- Auth and other middleware apply naturally: `authed.add("/private", staticFiles(...))`.
- The mount prefix comes from wherever the router is mounted, so the static router
  never needs to know its own URL prefix.
- `onError` and `notFound` behave exactly as they do for other routers.

`withStatic()` stays available so the decision in `questions.md` Q35 still holds.

## Public API

```ts
import { r, serve } from "@fishenv/http";
import { staticFiles } from "@fishenv/http/static";

const assets = staticFiles({
  root: "./public", // required; resolved and realpath'd once at creation
  index: ["index.html"], // default ["index.html"]; [] disables
  extensions: ["html"], // "/about" -> "about.html"; default []
  dotfiles: "hide", // "hide" (404, default) | "allow"
  allowDotfiles: [".well-known"], // exceptions to "hide", matched per segment
  symlinks: "within-root", // "within-root" (default) | "deny" | "follow"
  precompressed: ["br", "gzip"], // default []; order = server preference
  etag: true, // default true
  lastModified: true, // default true
  cacheControl: "no-cache", // default
  headers: {}, // added to every file response
  fallback: undefined, // e.g. "index.html" for SPAs; see "SPA fallback"
  exclude: [], // globs this router never serves, e.g. ["api/**"] when mounted at "/"
  cache: false, // true | { ttlMs, maxEntries }; see "Lookup cache"
  untrusted: false, // see "Untrusted content"
  rules: [
    {
      match: "assets/**/*.{js,css,woff2}",
      cacheControl: "public, max-age=31536000, immutable",
    },
    {
      match: "downloads/**",
      headers: { "Content-Disposition": "attachment" },
    },
    { match: "**/*.map", deny: true },
  ],
});

const app = r().add("/static", assets);
serve(app);

// Mixin sugar, equivalent to app.add("/static", staticFiles(opts))
withStatic(app, "/static", { root: "./public" });

// Single file from inside an ordinary handler
api.get("/report").handle(({ req }) => serveFile(req, reportPath));
```

### Rules

- `rules` is an ordered list. Every matching rule applies, and later rules
  override earlier ones per field (`cacheControl`, `headers` merge, `deny`).
- `match` uses **the same glob syntax as route paths** (`*`, `**`, `{a,b}`), so
  `buildRouteRegex` from `core/utils/url.ts` is reused. There is no second glob
  dialect and no user-supplied RegExp, which means no ReDoS surface.
- Matching runs on the **validated, decoded, `/`-joined relative path**, and
  is **case-insensitive**. On case-insensitive filesystems (macOS, Windows)
  this stops `.ENV` or `Secret.KEY` from slipping past a lowercase deny rule.
- `deny: true` gives a 404 that cannot be told apart from a missing file.
- Optional escape hatch: `setHeaders?(info: { path, stat }, headers: Headers)`
  for anything rules can't express. It runs after the rules.

### Untrusted content (`untrusted: true`)

This is for directories that hold user uploads served from the API origin.
Without it, an uploaded `.html` or `.svg` runs script with the API's cookies
(stored XSS). With it:

- `Content-Security-Policy: sandbox; default-src 'none'` is set on every response.
- `Content-Disposition: attachment` is set for every type except an allowlist
  of passive types (raster images, `text/plain`, `application/pdf`,
  audio/video).
- `symlinks` defaults to `"deny"` and `dotfiles` is forced to `"hide"`.

### SPA fallback (`fallback: "index.html"`)

Many of our apps will use this, so the behavior is specified exactly:

- **Startup.** The fallback file is resolved through the same pipeline
  (steps 2–8). It must exist as a regular file inside the root, or
  `staticFiles()` throws.
- **When it applies.** The fallback is served only when **all** of these hold:
  1. the normal lookup ended in "not found";
  2. the request was **not** rejected by validation, dotfile policy or a
     `deny` rule (those stay 404, so `/.env` never returns the app shell);
  3. the last path segment has no file extension (a missing `app.3f9a.js`
     stays 404, so a stale chunk doesn't come back as HTML and break the
     browser with a MIME error);
  4. the `Accept` header includes `text/html` or `*/*`, or is missing.
     API clients asking for `application/json` get a real 404.
- **Response.** Status `200`. `Cache-Control: no-cache` is set regardless of
  `cacheControl` and rules, so a new deploy's shell is never stuck in a cache.
  Normal ETag/304 handling still applies, which keeps revalidation cheap.
- **Mounting at `/`.** An SPA is usually mounted at the root next to the API:
  `app.add(api).add(spa(...))`. Specific API routes win on specificity, but an
  **unknown** `/api/foo` falls through to the SPA's `/:path*`. Most callers
  send `Accept: application/json` and get a 404 anyway (rule 4), but browser
  navigation or `fetch` without that header would get the HTML shell. Add an
  `exclude: ["api/**"]` option: excluded paths are never served by this
  router and never get the fallback, so they return the normal 404. Document
  this in the README and the example.
- **Helper.** `spa(opts)` is a shortcut for
  `staticFiles({ index: ["index.html"], fallback: "index.html", ...opts })`.

### Lookup cache (`cache`)

This caches the result of steps 6–8 plus encoding variant discovery, so hot
paths skip `realpath`/`stat` syscalls. It never caches file contents; Bun
streams those.

- `cache: true` means `{ ttlMs: 5_000, maxEntries: 10_000 }`. The default is
  `false`, because a cache makes edits during development appear late.
- **Key.** The validated relative path (after step 5). Raw URLs are never keys,
  so encodings of the same path share one entry and junk input can't make
  extra entries.
- **Value.** `{ absPath, size, mtimeMs, variants: { br?, gzip? } }` or a
  **negative** entry ("not found").
- **Bounded.** An LRU (a `Map` in insertion order) capped at `maxEntries`.
  Negative entries count toward the cap and get a shorter TTL
  (`min(ttlMs, 1000)`), so a random-URL flood can't grow memory or hide newly
  added files for long.
- **Rejected requests are not cached.** Validation, dotfile and deny decisions
  are cheap and deterministic, so they are not stored.
- **A hit still does one `stat` of `absPath`.** It skips the expensive part
  (`realpath` walks every component, plus up to two variant probes) but keeps
  size, mtime and ETag fresh. If the `stat` fails or the result is no longer a
  regular file, the entry is evicted and the full pipeline runs again. This
  matters because of the following (verified on Bun 1.4.3): a `Bun.file` whose
  path is gone when the response is sent throws ENOENT **outside** the
  router's error chain, so the response must never be built without a fresh
  check.
- `staticFiles()` returns `StaticRouter = Router & { invalidate(relPath?: string): void }`,
  so deploy hooks can clear the cache.

## Security model

### Threat model

- **In scope:** any attacker-controlled request URL and headers.
- **Trusted:** the configured root and the files the app owner puts there.
  When others can write to the root (uploads), use `untrusted: true`. Even
  then, a local attacker who can swap symlinks during a request (TOCTOU) is
  out of scope for v1. See the spike below.

### Request → file pipeline

Each step either continues or ends in a 404 (400 for malformed encoding).
`resolve.ts` holds this as one pure-ish function so it can be tested with a
table of attacks.

1. **Get the raw remainder.** Take it from the named rest param (see Core
   prerequisite), so it is still percent-encoded. WHATWG URL parsing has
   already collapsed `.`/`..`, including `%2e%2e` and backslashes, but it does
   **not** decode `%2F`, `%5C` or `%00`. The steps below handle those.
2. **Split, then decode.** Split on `/` first and only then
   `decodeURIComponent` each segment, so `..%2F..%2Fetc` turns into one
   segment that contains a `/`. A `URIError` gives 400. Decode exactly once,
   so `%252e%252e` stays the literal filename `%2e%2e`.
3. **Reject bad segments.** Reject empty segments (`a//b`) and `.` / `..`,
   plus any segment containing `/`, `\`, NUL or other C0 control characters.
   On Windows, also reject `:` (alternate data streams), trailing `.` or
   space, and reserved device names (`CON`, `NUL`, `COM1`, …).
4. **Dotfile policy.** Applies to *any* segment (`a/.git/config`, not just
   `.env`), minus the `allowDotfiles` exceptions.
5. **Rules.** Apply `deny` rules on the joined relative path, case-insensitively.
6. **Lexical containment.** `candidate = path.join(root, ...segments)`, then
   require `candidate === root || candidate.startsWith(root + path.sep)`. The
   old draft used `startsWith(root)`, which lets `/srv/public` reach
   `/srv/public-secrets`.
7. **Real-path containment.** Compare `realpath(candidate)` against
   `realRoot` (computed once at startup) using the same rule as step 6. With
   `symlinks: "deny"`, use `lstat` on every component instead.
8. **File type.** `stat` must be a regular file. Reject FIFOs, sockets and
   devices, because reading a FIFO hangs the request (DoS). For directories,
   go to step 9.
9. **Directories.**
   - Without a trailing slash, redirect `301` to a **relative** `Location`:
     `encodeURIComponent(lastSegment) + "/"`. Never build an absolute
     `Location` from the request path: `//evil.com/` is the classic
     serve-static open redirect.
   - With a trailing slash, try each `index` entry. Each one goes through
     steps 6–8 again.
10. **Extensions and fallback.** `extensions` and `fallback` candidates go
    through steps 6–8 as well. `fallback` is only used for requests whose last
    segment has no extension, so a missing `app.js` stays a 404 and never
    returns HTML.

### Response pipeline

1. **Pick the encoding.** Parse `Accept-Encoding` properly: q-values, `q=0`
   means refused, `*` is honored. For each configured encoding, check that
   `file + ".br"` / `".gz"` exists and passes steps 7–8. Always send
   `Vary: Accept-Encoding` when `precompressed` is non-empty, even when the
   identity file is served, to avoid cache poisoning.
2. **Validators.** Use a weak ETag `W/"<size>-<mtimeMs>[-br|-gz]"`. Leave the
   inode out (the Apache inode leak) and suffix it per encoding.
   `If-None-Match` takes a comma list, `*`, and weak comparison, and wins over
   `If-Modified-Since`. Answer with a 304 that has no body and keeps
   `ETag`/`Cache-Control`/`Vary`.
3. **Headers.** Set `Content-Type` from the **original** file even when
   serving `.br`, and set it explicitly (a `Bun.file(fd)` loses the type).
   Then `nosniff`, `Cache-Control`, rule headers, `untrusted` headers, and
   finally `setHeaders`.
4. **Body.** `new Response(Bun.file(resolved), { headers })`. Bun handles
   `Range`, `If-Range`, `Content-Length` and sendfile.

### Startup validation (`staticFiles()` throws)

- `root` must exist and be a directory once realpath'd.
- Throw if `root` is the filesystem root.
- `rules[].match` must compile. Unknown option keys throw, since a typo such as
  `dotFiles` silently falling back to a default is a security footgun.

## Core prerequisite: named rest parameter

Today `**` compiles to `(?:/.*)?` and **captures nothing**. A mounted router's
handler also can't recover its remainder by stripping a prefix, because mount
prefixes are added at `build()` time. So:

- `core/utils/url.ts`: support `:name*` as a final segment, compiling to
  `(?:/(.*))?` with `name` pushed to `paramNames`. The matcher gives it
  specificity 0, like `**`, so API routes always win over static.
- `contract/types.ts`: in `ExtractParams`, strip a trailing `*` from the name
  the same way `?` is stripped.
- Tests in `url.test.ts`, `matcher.test.ts` and `types.test.ts`.

The static router then registers `get("/:path*")` plus `get("/")` for the
mount root.

## Core prerequisite: generic 500 for errors outside the router chain

`serve()` passes no `error` hook to `Bun.serve`. An exception raised while
Bun streams a body, such as a static file deleted between `stat` and send,
therefore gets Bun's default error page, which shows the absolute path when
`development: true`. Add `error: () => new Response(null, { status: 500 })`
in `serve()` and log through `options.logger`.

## Module layout

Follows the `sse/` convention.

```
static/
  index.ts        — public exports + module doc
  types.ts        — StaticOptions, StaticRule, ResolvedFile
  options.ts      — normalize + validate options at creation (throws)
  resolve.ts      — request remainder → safe absolute path (pipeline steps 1–10)
  rules.ts        — compile rules via buildRouteRegex, case-insensitive match
  negotiate.ts    — Accept-Encoding parsing, conditional request evaluation
  response.ts     — serveFile(): stat → headers → Response
  router.ts       — staticFiles(), withStatic()
  *.test.ts
```

Add `"./static"` to `package.json` `exports`.

## Test plan

A table-driven attack corpus against `resolve.ts`, plus end-to-end tests
through `router.fetch`:

- Traversal: `../`, `%2e%2e/`, `.%2e/`, `..%2f`, `..%5c`, `..\\`, `%2e%2e%2f`,
  double-encoded `%252e%252e%252f` (must be a literal name, so 404), absolute
  path after decoding (`%2fetc%2fpasswd`), sibling-prefix escape
  (`../public-secrets/x`).
- NUL and control characters: `%00`, `a%00.txt`, `%0a`.
- Dotfiles: `.env`, `.ENV`, `a/.git/config`, `.well-known/x` allowed via exception.
- Symlinks: link out of the root (404), link within the root (200 under
  `within-root`, 404 under `deny`), dangling link.
- Special files: a FIFO in the root returns 404 and does not hang.
- Redirects: `GET //evil.com` and `GET /static/dir` produce a relative `Location` only.
- Rules: deny wins, case-insensitive matching, header merge order.
- Negotiation: `br;q=0, gzip` gives gzip, a missing `.br` falls back, `Vary`
  is always present, the ETag differs per encoding.
- Conditionals: 304 for an ETag list, for `*`, and for `If-Modified-Since`;
  `If-None-Match` wins.
- Range: 206 single range, `If-Range` mismatch gives 200, multi-range gives
  200, and all of these still work behind `.cors()`.
- HEAD: same headers, no body. Non-GET methods give 405.
- `untrusted: true`: an `.html` upload gets CSP sandbox and attachment.
- SPA fallback: `/dashboard/settings` gives the shell with `no-cache`;
  `/missing.js` gives 404; `/.env` and denied paths give 404 (no shell);
  `Accept: application/json` gives 404; `exclude`d `api/**` gives 404; a
  missing fallback file throws at creation.
- Cache: a hit skips `realpath` (spy); a file deleted after caching gives 404,
  not a crash; negative entries expire; the LRU stays at or below
  `maxEntries` under a random-URL flood; `invalidate()` clears entries.
- Rest param: `/:path*` matches `/`, `/a`, `/a/b/c`; API routes win on specificity.

## Spikes before implementation

- **TOCTOU-proof open.** `open(real, O_RDONLY|O_NOFOLLOW)` → `fstat(fd)` →
  `Bun.file(fd)` works (verified: it streams, but the type is lost). Still
  unknown: who closes the fd, and whether Bun's Range support still applies.
  If it turns out clean, make it the `untrusted` code path.
- **Windows.** Confirm the step-3 rules against Bun on Windows (8.3 short
  names such as `SECRET~1.TXT` can bypass name-based deny rules). The
  realpath check covers containment, but not deny-rule bypass.

## Resolved questions

- **Q-S1** `staticFiles()` is the primary API; `withStatic()` is sugar. Accepted.
- **Q-S2** `:path*` rest param. It is consistent with `:name` / `:name?`.
- **Q-S3** 400 for undecodable `%`, 404 for everything else.
- **Q-S4** Directory listing deferred to v1.1.
- **Q-S5** SPA fallback in v1, with a `spa()` shortcut and `exclude`.
- **Q-S6** Lookup cache in v1: opt-in, bounded LRU, one `stat` per hit.

## Implementation order

1. Core: `:name*` rest param (url, matcher, types) + `serve()` error hook.
2. `resolve.ts` + attack-corpus tests (the security core, no I/O beyond `realpath`/`stat`).
3. `rules.ts`, `options.ts` (startup validation).
4. `negotiate.ts` + `response.ts` (`serveFile`).
5. `router.ts`: `staticFiles`, `withStatic`, `spa`, fallback, `exclude`.
6. Lookup cache.
7. TOCTOU and Windows spikes; fold results into the `untrusted` path.
8. `package.json` export, README section, `examples/static/` (API + SPA at `/`).
