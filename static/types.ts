/** Pre-compressed sibling encodings: `file.br` and `file.gz`. */
export type StaticEncoding = "br" | "gzip";

/** Per-path overrides, matched against the decoded relative path. */
export interface StaticRule {
  /** Route-style glob (`*`, `**`, `{a,b}`), matched case-insensitively. */
  match: string;
  cacheControl?: string;
  headers?: Record<string, string>;
  /** Respond 404 as if the file did not exist. */
  deny?: boolean;
}

/** What `setHeaders` learns about the file being served. */
export interface StaticFileInfo {
  /** Relative `/`-joined path inside the root (absolute for `serveFile`). */
  path: string;
  size: number;
  mtime: Date;
  /** Set when a pre-compressed sibling is served. */
  encoding?: StaticEncoding;
}

export type SetHeadersFn = (info: StaticFileInfo, headers: Headers) => void;

/** Response options shared by `staticFiles()` and `serveFile()`. */
export interface StaticResponseOptions {
  /** Sibling encodings to look for, in server preference order. Default `[]`. */
  precompressed?: StaticEncoding[];
  /** Default `true`. */
  etag?: boolean;
  /** Default `true`. */
  lastModified?: boolean;
  /** Default `"no-cache"`. */
  cacheControl?: string;
  /** Added to every file response. */
  headers?: Record<string, string>;
  /**
   * Serve files as untrusted (user uploads): CSP sandbox on every response and
   * `Content-Disposition: attachment` for anything but passive media types.
   */
  untrusted?: boolean;
  /** Runs last; may override any header. */
  setHeaders?: SetHeadersFn;
}

export interface StaticCacheOptions {
  /** Default 5000. */
  ttlMs?: number;
  /** Default 10000. */
  maxEntries?: number;
}

export interface StaticOptions extends StaticResponseOptions {
  /** Directory to serve. Resolved through symlinks once, at creation. */
  root: string;
  /** File names tried for directory requests. Default `["index.html"]`. */
  index?: string[];
  /** Extensions tried for extension-less misses, e.g. `["html"]`. Default `[]`. */
  extensions?: string[];
  /** `"hide"` (default) answers 404 for any path segment starting with `.`. */
  dotfiles?: "hide" | "allow";
  /** Dot-segments still served under `dotfiles: "hide"`, e.g. `[".well-known"]`. */
  allowDotfiles?: string[];
  /**
   * `"within-root"` (default) follows links whose target stays inside the
   * root; `"deny"` refuses any link; `"follow"` follows links anywhere.
   * Defaults to `"deny"` when `untrusted` is set.
   */
  symlinks?: "within-root" | "deny" | "follow";
  /** Ordered per-path overrides; later rules win per field. */
  rules?: StaticRule[];
  /** Globs this router never serves (and never falls back for). */
  exclude?: string[];
  /**
   * File served for unknown extension-less paths when the client accepts
   * HTML (SPA routing), e.g. `"index.html"`. Always sent `no-cache`.
   */
  fallback?: string;
  /** Cache path resolution (not contents). `true` uses the defaults. */
  cache?: boolean | StaticCacheOptions;
}
