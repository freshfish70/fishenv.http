/**
 * Static file serving for `@fishenv/http`.
 *
 * `staticFiles()` returns an ordinary router, so it is mounted, prefixed and
 * wrapped in middleware like any other:
 *
 * ```ts
 * app.add("/assets", staticFiles({ root: "./public" }));
 * app.add(api).add(spa({ root: "./dist", exclude: ["api/**"] }));
 * ```
 *
 * Requests are decoded and validated per segment, confined to the real root
 * (symlinks included), dotfiles are hidden and every rejection is a plain 404.
 *
 * Module layout:
 * - `types.ts`     — option and rule types
 * - `options.ts`   — validation and normalization at creation (throws)
 * - `resolve.ts`   — request path → file on disk (the security core)
 * - `rules.ts`     — route-style globs for rules and `exclude`
 * - `negotiate.ts` — Accept-Encoding, Accept and conditional requests
 * - `response.ts`  — headers and body; `serveFile()`
 * - `router.ts`    — `staticFiles()`, `spa()`, `withStatic()`
 */

export { serveFile } from "./response.ts";
export type { StaticRouter } from "./router.ts";
export { spa, staticFiles, withStatic } from "./router.ts";
export type {
  SetHeadersFn,
  StaticCacheOptions,
  StaticEncoding,
  StaticFileInfo,
  StaticOptions,
  StaticResponseOptions,
  StaticRule,
} from "./types.ts";
