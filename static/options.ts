import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isSafeSegment, isWithin, type SymlinkPolicy } from "./resolve.ts";
import {
  applyRules,
  type CompiledRule,
  compileGlob,
  compileRules,
  matchesGlob,
} from "./rules.ts";
import type {
  SetHeadersFn,
  StaticEncoding,
  StaticOptions,
  StaticResponseOptions,
} from "./types.ts";

const RESPONSE_KEYS = [
  "precompressed",
  "etag",
  "lastModified",
  "cacheControl",
  "headers",
  "untrusted",
  "setHeaders",
] as const;

const STATIC_KEYS = new Set<string>([
  ...RESPONSE_KEYS,
  "root",
  "index",
  "extensions",
  "dotfiles",
  "allowDotfiles",
  "symlinks",
  "rules",
  "exclude",
  "fallback",
  "cache",
]);

const ENCODINGS: StaticEncoding[] = ["br", "gzip"];

/** Normalized response options. */
export interface ResponseConfig {
  precompressed: StaticEncoding[];
  etag: boolean;
  lastModified: boolean;
  cacheControl: string;
  headers: Record<string, string>;
  untrusted: boolean;
  setHeaders?: SetHeadersFn;
}

export interface StaticConfig extends ResponseConfig {
  root: string;
  index: string[];
  extensions: string[];
  dotfiles: "hide" | "allow";
  allowDotfiles: Set<string>;
  symlinks: SymlinkPolicy;
  rules: CompiledRule[];
  exclude: RegExp[];
  fallback?: string[];
  cache?: { ttlMs: number; maxEntries: number };
  windows: boolean;
}

function fail(message: string): never {
  throw new Error(`static: ${message}`);
}

function checkKeys(opts: object, known: Set<string>, what: string): void {
  for (const key of Object.keys(opts)) {
    if (!known.has(key)) fail(`unknown ${what} option "${key}"`);
  }
}

function stringArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    fail(`"${name}" must be an array of strings`);
  }
  return value;
}

/** Validate and normalize the options shared with `serveFile()`. */
export function compileResponseOptions(
  opts: StaticResponseOptions,
): ResponseConfig {
  const precompressed = stringArray(opts.precompressed, "precompressed");
  for (const enc of precompressed) {
    if (!ENCODINGS.includes(enc as StaticEncoding)) {
      fail(`unsupported precompressed encoding "${enc}" (use "br" | "gzip")`);
    }
  }
  if (opts.setHeaders !== undefined && typeof opts.setHeaders !== "function") {
    fail(`"setHeaders" must be a function`);
  }
  return {
    precompressed: [...new Set(precompressed)] as StaticEncoding[],
    etag: opts.etag ?? true,
    lastModified: opts.lastModified ?? true,
    cacheControl: opts.cacheControl ?? "no-cache",
    headers: { ...opts.headers },
    untrusted: opts.untrusted ?? false,
    setHeaders: opts.setHeaders,
  };
}

export function compileServeFileOptions(
  opts: StaticResponseOptions,
): ResponseConfig {
  checkKeys(opts, new Set(RESPONSE_KEYS), "serveFile");
  return compileResponseOptions(opts);
}

/** True when `segments` may be served at all (dotfiles, deny, exclude). */
export function isServable(cfg: StaticConfig, segments: string[]): boolean {
  if (cfg.dotfiles === "hide") {
    for (const segment of segments) {
      if (
        segment.startsWith(".") &&
        !cfg.allowDotfiles.has(segment.toLowerCase())
      ) {
        return false;
      }
    }
  }
  const rel = segments.join("/");
  if (cfg.exclude.some((re) => matchesGlob(re, rel))) return false;
  return !applyRules(cfg.rules, rel).deny;
}

/** Validate options and resolve the root. Throws on any misconfiguration. */
export function compileStaticOptions(opts: StaticOptions): StaticConfig {
  if (typeof opts !== "object" || opts === null) fail("options are required");
  checkKeys(opts, STATIC_KEYS, "staticFiles");

  if (typeof opts.root !== "string" || opts.root === "") {
    fail(`"root" is required`);
  }
  let root: string;
  try {
    root = realpathSync(path.resolve(opts.root));
  } catch {
    fail(`root "${opts.root}" does not exist`);
  }
  if (!statSync(root).isDirectory()) {
    fail(`root "${opts.root}" is not a directory`);
  }
  if (path.parse(root).root === root) {
    fail("refusing to serve the filesystem root");
  }

  const untrusted = opts.untrusted ?? false;
  const dotfiles = opts.dotfiles ?? "hide";
  if (dotfiles !== "hide" && dotfiles !== "allow") {
    fail(`"dotfiles" must be "hide" or "allow"`);
  }
  if (untrusted && dotfiles === "allow") {
    fail(`"dotfiles: allow" cannot be combined with "untrusted"`);
  }
  const symlinks = opts.symlinks ?? (untrusted ? "deny" : "within-root");
  if (!["within-root", "deny", "follow"].includes(symlinks)) {
    fail(`"symlinks" must be "within-root", "deny" or "follow"`);
  }

  const windows = process.platform === "win32";
  const index = stringArray(opts.index ?? ["index.html"], "index");
  for (const name of index) {
    if (!isSafeSegment(name, windows)) fail(`invalid index name "${name}"`);
  }
  const extensions = stringArray(opts.extensions, "extensions").map((e) =>
    e.replace(/^\./, ""),
  );
  for (const ext of extensions) {
    if (!isSafeSegment(`x.${ext}`, windows) || ext === "") {
      fail(`invalid extension "${ext}"`);
    }
  }

  let cache: StaticConfig["cache"];
  if (opts.cache) {
    const c = opts.cache === true ? {} : opts.cache;
    checkKeys(c, new Set(["ttlMs", "maxEntries"]), "cache");
    cache = { ttlMs: c.ttlMs ?? 5_000, maxEntries: c.maxEntries ?? 10_000 };
    if (!(cache.ttlMs > 0) || !(cache.maxEntries >= 1)) {
      fail(`"cache.ttlMs" and "cache.maxEntries" must be positive`);
    }
  }

  const cfg: StaticConfig = {
    ...compileResponseOptions(opts),
    root,
    index,
    extensions,
    dotfiles,
    allowDotfiles: new Set(
      stringArray(opts.allowDotfiles, "allowDotfiles").map((s) =>
        s.toLowerCase(),
      ),
    ),
    symlinks,
    rules: compileRules(opts.rules ?? []),
    exclude: stringArray(opts.exclude, "exclude").map(compileGlob),
    cache,
    windows,
  };

  if (opts.fallback !== undefined) {
    cfg.fallback = compileFallback(cfg, opts.fallback);
  }
  return cfg;
}

/** The fallback must be a servable regular file inside the root. */
function compileFallback(cfg: StaticConfig, fallback: string): string[] {
  if (typeof fallback !== "string") fail(`"fallback" must be a string`);
  const segments = fallback.replace(/^\/+/, "").split("/");
  if (!segments.every((s) => isSafeSegment(s, cfg.windows))) {
    fail(`invalid fallback path "${fallback}"`);
  }
  if (!isServable(cfg, segments)) {
    fail(`fallback "${fallback}" is hidden by dotfiles, rules or exclude`);
  }
  try {
    const real = realpathSync(path.join(cfg.root, ...segments));
    if (isWithin(cfg.root, real) && statSync(real).isFile()) return segments;
  } catch {
    // fall through
  }
  return fail(`fallback "${fallback}" is not a file inside the root`);
}
