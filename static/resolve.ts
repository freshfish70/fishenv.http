/**
 * Request path → file on disk. Every step either continues or rejects; see
 * `.plan/12-static-files.md` ("Request → file pipeline") for the reasoning
 * behind each check.
 */

import type { Stats } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Filesystem calls used by the resolver. Exported so tests can observe how
 * many syscalls a lookup performs; not part of the public API.
 */
export const fsOps = { lstat, realpath, stat };

export interface ParsedPath {
  /** Decoded, validated segments. Empty for the mount root. */
  segments: string[];
  /** The request ended in `/` (a directory request). */
  trailingSlash: boolean;
}

/** Marker for `%` sequences that fail to decode (→ 400). */
export const BAD_ENCODING = Symbol("bad-encoding");

// C0 controls and DEL.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// Characters Windows refuses in names, plus `:` (alternate data streams).
const WINDOWS_FORBIDDEN = /[<>:"|?*]/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Validate one decoded segment (step 3). */
export function isSafeSegment(segment: string, windows: boolean): boolean {
  if (segment === "" || segment === "." || segment === "..") return false;
  if (segment.includes("/") || segment.includes("\\")) return false;
  if (CONTROL_CHARS.test(segment)) return false;
  if (windows) {
    if (WINDOWS_FORBIDDEN.test(segment)) return false;
    if (/[. ]$/.test(segment)) return false;
    if (WINDOWS_DEVICE.test(segment)) return false;
  }
  return true;
}

/**
 * Steps 1–3: split the raw (percent-encoded) remainder on `/`, then decode
 * each segment exactly once and validate it. Splitting before decoding is
 * what turns `..%2F..%2Fetc` into a single (rejected) segment.
 *
 * Returns `null` for a path that can never be served (→ 404).
 */
export function parseRequestPath(
  raw: string | undefined,
  windows = process.platform === "win32",
): ParsedPath | typeof BAD_ENCODING | null {
  if (raw === undefined || raw === "") {
    // `/mount` (no slash) vs `/mount/`: the rest param is absent vs empty.
    return { segments: [], trailingSlash: raw === "" };
  }

  const parts = raw.split("/");
  const trailingSlash = parts[parts.length - 1] === "";
  if (trailingSlash) parts.pop();

  const segments: string[] = [];
  for (const part of parts) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return BAD_ENCODING;
    }
    if (!isSafeSegment(decoded, windows)) return null;
    segments.push(decoded);
  }
  return { segments, trailingSlash };
}

/** Lexical containment: `candidate` is `root` or strictly below it. */
export function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

export type SymlinkPolicy = "within-root" | "deny" | "follow";

export interface Located {
  /** Path to open: the resolved real path, except under `"follow"`. */
  abs: string;
  stat: Stats;
}

/**
 * Policy check on the canonical (on-disk) segments of what was resolved.
 * The request may have named it through an alias — an in-root symlink, a
 * Windows 8.3 short name, other case on a case-insensitive disk, another
 * Unicode normalization — so dotfile and deny rules must also hold here.
 */
export type CanonicalCheck = (segments: string[]) => boolean;

/**
 * Steps 6–8: map validated segments to a regular file or directory inside
 * `root` (which must already be a real path). Anything else — missing,
 * escaping, a forbidden symlink, a FIFO/socket/device, a canonical name
 * that `allow` rejects — is `null`.
 */
export async function locate(
  root: string,
  segments: string[],
  symlinks: SymlinkPolicy,
  allow?: CanonicalCheck,
): Promise<Located | null> {
  const candidate = path.join(root, ...segments);
  if (!isWithin(root, candidate)) return null;

  try {
    if (symlinks === "deny") {
      let current = root;
      for (const segment of segments) {
        current = path.join(current, segment);
        if ((await fsOps.lstat(current)).isSymbolicLink()) return null;
      }
    }

    const real = await fsOps.realpath(candidate);
    const inside = isWithin(root, real);
    if (!inside && symlinks !== "follow") return null;
    // Under "follow" a target outside the root was explicitly allowed;
    // there is no in-root name to check rules against.
    if (inside && allow && !allow(canonicalSegments(root, real))) return null;

    const abs = symlinks === "follow" ? candidate : real;
    const st = await fsOps.stat(abs);
    if (!st.isFile() && !st.isDirectory()) return null;
    return { abs, stat: st };
  } catch {
    return null;
  }
}

function canonicalSegments(root: string, real: string): string[] {
  return path.relative(root, real).split(path.sep).filter(Boolean);
}
