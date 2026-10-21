import { stat } from "node:fs/promises";
import { NotFoundError } from "../core/index.ts";
import { chooseEncoding, isNotModified, makeEtag } from "./negotiate.ts";
import { compileServeFileOptions, type ResponseConfig } from "./options.ts";
import type { StaticEncoding, StaticResponseOptions } from "./types.ts";

/** A file ready to be served, with its fresh `stat`. */
export interface ServableFile {
  /** Path handed to `setHeaders` (relative for `staticFiles`). */
  path: string;
  /** Original file; decides `Content-Type` even when a variant is sent. */
  contentTypeFrom: string;
  /** File actually sent (original or `.br` / `.gz` sibling). */
  abs: string;
  size: number;
  mtimeMs: number;
  encoding?: StaticEncoding;
}

/** Per-response extras from `staticFiles` (rules, SPA fallback). */
export interface ResponseExtras {
  cacheControl?: string;
  headers?: Record<string, string>;
  /** SPA shell: force `no-cache` over options and rules. */
  forceNoCache?: boolean;
}

/** Types that cannot run script, so `untrusted` may show them inline. */
function isPassiveType(contentType: string): boolean {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type.startsWith("image/")) return type !== "image/svg+xml";
  return (
    type.startsWith("audio/") ||
    type.startsWith("video/") ||
    type === "text/plain" ||
    type === "application/pdf"
  );
}

// Headers a 304 keeps (RFC 9110 §15.4.5).
const NOT_MODIFIED_HEADERS = [
  "cache-control",
  "content-location",
  "etag",
  "expires",
  "last-modified",
  "vary",
];

/** Build the response for a resolved file: headers, conditionals, body. */
export function buildFileResponse(
  req: Request,
  file: ServableFile,
  cfg: ResponseConfig,
  extras: ResponseExtras = {},
): Response {
  const contentType = Bun.file(file.contentTypeFrom).type;
  const etag = cfg.etag
    ? makeEtag(file.size, file.mtimeMs, file.encoding)
    : undefined;

  const headers = new Headers({
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": cfg.cacheControl,
  });
  if (cfg.precompressed.length > 0) headers.set("Vary", "Accept-Encoding");
  if (etag) headers.set("ETag", etag);
  if (cfg.lastModified) {
    headers.set("Last-Modified", new Date(file.mtimeMs).toUTCString());
  }
  if (file.encoding) headers.set("Content-Encoding", file.encoding);
  // Bun adds it itself to 206 responses; setting it too would duplicate it.
  if (!req.headers.has("range")) headers.set("Accept-Ranges", "bytes");

  for (const [k, v] of Object.entries(cfg.headers)) headers.set(k, v);
  if (extras.cacheControl) headers.set("Cache-Control", extras.cacheControl);
  for (const [k, v] of Object.entries(extras.headers ?? {})) headers.set(k, v);

  if (cfg.untrusted) {
    headers.set("Content-Security-Policy", "sandbox; default-src 'none'");
    if (!isPassiveType(contentType)) {
      headers.set("Content-Disposition", "attachment");
    }
  }
  if (extras.forceNoCache) headers.set("Cache-Control", "no-cache");

  cfg.setHeaders?.(
    {
      path: file.path,
      size: file.size,
      mtime: new Date(file.mtimeMs),
      encoding: file.encoding,
    },
    headers,
  );

  if (isNotModified(req, etag, cfg.lastModified ? file.mtimeMs : undefined)) {
    const kept = new Headers();
    for (const name of NOT_MODIFIED_HEADERS) {
      const value = headers.get(name);
      if (value !== null) kept.set(name, value);
    }
    return new Response(null, { status: 304, headers: kept });
  }

  // Bun applies Range / If-Range to file bodies and sends via sendfile.
  return new Response(Bun.file(file.abs), { headers });
}

/** Stat a candidate and return it only if it is a regular file. */
export async function statFile(
  abs: string,
): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const st = await stat(abs);
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

/**
 * Serve one known file from a handler, with the same headers, validators
 * and pre-compressed negotiation as `staticFiles()`.
 *
 * `absPath` is trusted: never build it from request input — use
 * `staticFiles()` for that. Throws `NotFoundError` when it is not a file.
 *
 * ```ts
 * api.get("/report").handle(({ req }) => serveFile(req, reportPath));
 * ```
 */
export async function serveFile(
  req: Request,
  absPath: string,
  opts: StaticResponseOptions = {},
): Promise<Response> {
  const cfg = compileServeFileOptions(opts);
  const original = await statFile(absPath);
  if (!original) throw new NotFoundError();

  const variants: Partial<Record<StaticEncoding, string>> = {};
  for (const enc of cfg.precompressed) {
    variants[enc] = `${absPath}${enc === "br" ? ".br" : ".gz"}`;
  }
  return serveWithVariants(req, cfg, {
    path: absPath,
    abs: absPath,
    stat: original,
    variants,
  });
}

/**
 * Choose an encoding among candidate sibling paths, stat the chosen file
 * fresh, and fall back to the original when a variant has vanished.
 */
export async function serveWithVariants(
  req: Request,
  cfg: ResponseConfig,
  target: {
    path: string;
    abs: string;
    stat: { size: number; mtimeMs: number };
    variants: Partial<Record<StaticEncoding, string>>;
  },
  extras?: ResponseExtras,
): Promise<Response> {
  const acceptEncoding = req.headers.get("accept-encoding");
  let available = cfg.precompressed.filter((enc) => target.variants[enc]);

  while (available.length > 0) {
    const encoding = chooseEncoding(acceptEncoding, available);
    if (!encoding) break;
    const abs = target.variants[encoding] as string;
    const st = await statFile(abs);
    if (st) {
      return buildFileResponse(
        req,
        {
          path: target.path,
          contentTypeFrom: target.abs,
          abs,
          ...st,
          encoding,
        },
        cfg,
        extras,
      );
    }
    available = available.filter((e) => e !== encoding);
  }

  return buildFileResponse(
    req,
    {
      path: target.path,
      contentTypeFrom: target.abs,
      abs: target.abs,
      ...target.stat,
    },
    cfg,
    extras,
  );
}
