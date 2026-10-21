import type { StaticEncoding } from "./types.ts";

interface QItem {
  value: string;
  q: number;
}

/** Parse a `token;q=0.5, other` header into lowercase values with weights. */
export function parseQList(header: string): QItem[] {
  const items: QItem[] = [];
  for (const part of header.split(",")) {
    const [rawValue, ...params] = part.split(";");
    const value = rawValue.trim().toLowerCase();
    if (!value) continue;
    let q = 1;
    for (const param of params) {
      const [k, v] = param.split("=").map((s) => s.trim());
      if (k.toLowerCase() === "q") {
        const n = Number(v);
        q = Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : 0;
      }
    }
    items.push({ value, q });
  }
  return items;
}

const CODING_NAMES: Record<StaticEncoding, string[]> = {
  br: ["br"],
  gzip: ["gzip", "x-gzip"],
};

/**
 * Pick the best available encoding for an `Accept-Encoding` header. Highest
 * q wins; ties go to `available` order (server preference). `q=0` refuses a
 * coding, `*` covers codings not listed. No header means identity only.
 */
export function chooseEncoding(
  header: string | null,
  available: StaticEncoding[],
): StaticEncoding | undefined {
  if (!header || available.length === 0) return undefined;
  const items = parseQList(header);
  const star = items.find((i) => i.value === "*")?.q;

  let best: StaticEncoding | undefined;
  let bestQ = 0;
  for (const enc of available) {
    const explicit = items.find((i) => CODING_NAMES[enc].includes(i.value));
    const q = explicit?.q ?? star ?? 0;
    if (q > bestQ) {
      best = enc;
      bestQ = q;
    }
  }
  return best;
}

/** True when the client accepts an HTML document (used for SPA fallback). */
export function acceptsHtml(header: string | null): boolean {
  if (!header) return true;
  return parseQList(header).some(
    (i) =>
      i.q > 0 &&
      (i.value === "text/html" || i.value === "text/*" || i.value === "*/*"),
  );
}

/** Weak ETag from size + mtime (no inode), suffixed per encoding. */
export function makeEtag(
  size: number,
  mtimeMs: number,
  encoding?: StaticEncoding,
): string {
  const suffix = encoding ? `-${encoding}` : "";
  return `W/"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}${suffix}"`;
}

function opaqueTag(tag: string): string {
  return tag.trim().replace(/^W\//, "");
}

/**
 * Evaluate `If-None-Match` (weak comparison, `*`, lists), falling back to
 * `If-Modified-Since` only when `If-None-Match` is absent (RFC 9110 §13.2.2).
 */
export function isNotModified(
  req: Request,
  etag: string | undefined,
  mtimeMs: number | undefined,
): boolean {
  const inm = req.headers.get("if-none-match");
  if (inm !== null) {
    if (!etag) return false;
    if (inm.trim() === "*") return true;
    const ours = opaqueTag(etag);
    return inm.split(",").some((t) => opaqueTag(t) === ours);
  }

  const ims = req.headers.get("if-modified-since");
  if (ims !== null && mtimeMs !== undefined) {
    const since = Date.parse(ims);
    if (Number.isNaN(since)) return false;
    // HTTP dates have second precision.
    return Math.floor(mtimeMs / 1000) * 1000 <= since;
  }
  return false;
}
