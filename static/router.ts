/** `staticFiles()`, `spa()` and the `withStatic()` mixin. */

import path from "node:path";
import {
  BadRequestError,
  NotFoundError,
  type Router,
  r,
} from "../core/index.ts";
import { acceptsHtml } from "./negotiate.ts";
import {
  compileStaticOptions,
  isServable,
  type StaticConfig,
} from "./options.ts";
import { BAD_ENCODING, locate, parseRequestPath } from "./resolve.ts";
import {
  type ResponseExtras,
  serveWithVariants,
  statFile,
} from "./response.ts";
import { applyRules } from "./rules.ts";
import type { StaticEncoding, StaticOptions } from "./types.ts";

/** Outcome of mapping a validated request path to the filesystem. */
type Lookup =
  | {
      kind: "file";
      /** Relative path of the file actually served (may be an index). */
      rel: string;
      abs: string;
      variants: Partial<Record<StaticEncoding, string>>;
    }
  | { kind: "redirect" }
  | { kind: "missing" };

interface CacheEntry {
  lookup: Lookup;
  expires: number;
}

/** A router serving a directory; `invalidate()` clears the lookup cache. */
export type StaticRouter = Router<
  Record<never, never>,
  Record<never, never>
> & {
  invalidate(relPath?: string): void;
};

/**
 * Serve a directory as a mountable router:
 *
 * ```ts
 * app.add("/assets", staticFiles({ root: "./public" }));
 * ```
 *
 * Paths are decoded and validated per segment, kept inside the (real) root,
 * and dotfiles are hidden by default. Every rejection is a plain 404
 * (`NotFoundError`), except undecodable `%` sequences (`BadRequestError`).
 * Throws at creation on any misconfiguration.
 */
export function staticFiles(opts: StaticOptions): StaticRouter {
  const cfg = compileStaticOptions(opts);
  const cache = cfg.cache ? new LookupCache(cfg.cache) : null;
  const router = r();

  router.get("/:path*").handle(async ({ req, path: params }) => {
    const raw = (params as { path?: string }).path;
    const parsed = parseRequestPath(raw, cfg.windows);
    if (parsed === BAD_ENCODING) throw new BadRequestError();
    if (parsed === null || !isServable(cfg, parsed.segments)) {
      throw new NotFoundError();
    }

    const key = parsed.segments.join("/") + (parsed.trailingSlash ? "/" : "");
    const found = await resolveFresh(cfg, cache, key, parsed);

    if (found.kind === "file") return serveLookup(req, cfg, found, found.stat);
    if (found.kind === "redirect") return redirectToDirectory(req);

    if (cfg.fallback && isFallbackEligible(req, parsed.segments)) {
      const shell = await withStat(await lookup(cfg, cfg.fallback, false));
      if (shell?.kind === "file") {
        return serveLookup(req, cfg, shell, shell.stat, { forceNoCache: true });
      }
    }
    throw new NotFoundError();
  });

  return Object.defineProperty(router, "invalidate", {
    value: (relPath?: string) => cache?.invalidate(relPath),
    enumerable: false,
    configurable: true,
  }) as StaticRouter;
}

/**
 * Single-page app: `staticFiles()` with `index.html` as both the directory
 * index and the fallback for unknown, extension-less HTML requests.
 *
 * ```ts
 * app.add(api).add(spa({ root: "./dist", exclude: ["api/**"] }));
 * ```
 */
export function spa(
  opts: Omit<StaticOptions, "fallback"> & { fallback?: string },
): StaticRouter {
  return staticFiles({
    index: ["index.html"],
    fallback: "index.html",
    ...opts,
  });
}

/** Mixin sugar for `router.add(prefix, staticFiles(opts))`. */
// biome-ignore lint/suspicious/noExplicitAny: accepts routers of any context
export function withStatic<R extends Router<any, any>>(
  router: R,
  prefix: string,
  opts: StaticOptions,
): R {
  router.add(prefix, staticFiles(opts));
  return router;
}

// ── Internals ─────────────────────────────────────────────────────────────

type FreshLookup =
  | (Extract<Lookup, { kind: "file" }> & {
      stat: { size: number; mtimeMs: number };
    })
  | Exclude<Lookup, { kind: "file" }>;

/** Attach a fresh stat to a file lookup; `null` if it is no longer a file. */
async function withStat(found: Lookup): Promise<FreshLookup | null> {
  if (found.kind !== "file") return found;
  const stat = await statFile(found.abs);
  return stat ? { ...found, stat } : null;
}

/**
 * Look up through the cache, but never build a response from a cached file
 * without a fresh stat: a vanished or replaced entry is resolved again.
 */
async function resolveFresh(
  cfg: StaticConfig,
  cache: LookupCache | null,
  key: string,
  parsed: { segments: string[]; trailingSlash: boolean },
): Promise<FreshLookup> {
  const cached = cache?.get(key);
  if (cached) {
    const fresh = await withStat(cached);
    if (fresh) return fresh;
    cache?.delete(key);
  }
  const found = await lookup(cfg, parsed.segments, parsed.trailingSlash);
  const fresh = await withStat(found);
  if (fresh) {
    cache?.set(key, found);
    return fresh;
  }
  return { kind: "missing" };
}

function serveLookup(
  req: Request,
  cfg: StaticConfig,
  found: Extract<Lookup, { kind: "file" }>,
  stat: { size: number; mtimeMs: number },
  extras: ResponseExtras = {},
): Promise<Response> {
  const rules = applyRules(cfg.rules, found.rel);
  return serveWithVariants(
    req,
    cfg,
    { path: found.rel, abs: found.abs, stat, variants: found.variants },
    { cacheControl: rules.cacheControl, headers: rules.headers, ...extras },
  );
}

/** Steps 6–10: file, directory index, redirect, extension fallback. */
async function lookup(
  cfg: StaticConfig,
  segments: string[],
  trailingSlash: boolean,
): Promise<Lookup> {
  const target = await locate(
    cfg.root,
    segments,
    cfg.symlinks,
    cfg.allowCanonical,
  );

  if (target?.stat.isDirectory()) {
    if (cfg.index.length === 0) return { kind: "missing" };
    if (!trailingSlash) return { kind: "redirect" };
    for (const name of cfg.index) {
      const found = await findFile(cfg, [...segments, name]);
      if (found) return found;
    }
    return { kind: "missing" };
  }

  if (target && !trailingSlash) return withVariants(cfg, segments, target.abs);

  if (!trailingSlash && segments.length > 0) {
    const last = segments[segments.length - 1];
    for (const ext of cfg.extensions) {
      const found = await findFile(cfg, [
        ...segments.slice(0, -1),
        `${last}.${ext}`,
      ]);
      if (found) return found;
    }
  }
  return { kind: "missing" };
}

/** A derived candidate (index, extension) is checked like a request path. */
async function findFile(
  cfg: StaticConfig,
  segments: string[],
): Promise<Lookup | null> {
  if (!isServable(cfg, segments)) return null;
  const located = await locate(
    cfg.root,
    segments,
    cfg.symlinks,
    cfg.allowCanonical,
  );
  if (!located?.stat.isFile()) return null;
  return withVariants(cfg, segments, located.abs);
}

async function withVariants(
  cfg: StaticConfig,
  segments: string[],
  abs: string,
): Promise<Lookup> {
  const variants: Partial<Record<StaticEncoding, string>> = {};
  const last = segments[segments.length - 1];
  for (const enc of cfg.precompressed) {
    const suffix = enc === "br" ? ".br" : ".gz";
    const sibling = await locate(
      cfg.root,
      [...segments.slice(0, -1), last + suffix],
      cfg.symlinks,
      cfg.allowCanonical,
    );
    if (sibling?.stat.isFile()) variants[enc] = sibling.abs;
  }
  return { kind: "file", rel: segments.join("/"), abs, variants };
}

/**
 * Redirect `/dir` to `/dir/` with a relative `Location` built from the last
 * URL segment. `./` keeps a segment like `https:evil.com` from reading as an
 * absolute URL; nothing here can produce `//host`.
 */
function redirectToDirectory(req: Request): Response {
  const url = new URL(req.url);
  const last = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  return new Response(null, {
    status: 301,
    headers: { Location: `./${last}/${url.search}` },
  });
}

function isFallbackEligible(req: Request, segments: string[]): boolean {
  const last = segments[segments.length - 1] ?? "";
  if (path.extname(last) !== "") return false;
  return acceptsHtml(req.headers.get("accept"));
}

/** Bounded LRU of lookups. Misses expire sooner than hits. Internal; exported for tests. */
export class LookupCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;

  constructor(opts: { ttlMs: number; maxEntries: number }) {
    this.#ttlMs = opts.ttlMs;
    this.#maxEntries = opts.maxEntries;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: string): Lookup | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    if (entry.expires <= Date.now()) return undefined;
    this.#entries.set(key, entry); // most recently used goes last
    return entry.lookup;
  }

  set(key: string, lookup: Lookup): void {
    const ttl =
      lookup.kind === "missing" ? Math.min(this.#ttlMs, 1_000) : this.#ttlMs;
    this.#entries.delete(key);
    this.#entries.set(key, { lookup, expires: Date.now() + ttl });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value as string;
      this.#entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  invalidate(relPath?: string): void {
    if (relPath === undefined) {
      this.#entries.clear();
      return;
    }
    const key = relPath.replace(/^\/+/, "").replace(/\/+$/, "");
    this.#entries.delete(key);
    this.#entries.delete(`${key}/`);
  }
}
