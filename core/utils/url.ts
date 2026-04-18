/**
 * Combine a base prefix and a route sub-path into one canonical path.
 * Always returns a path starting with "/" and no trailing slash (except root).
 */
export function mergePaths(base: string, sub: string): string {
  const combined = `${base.replace(/\/+$/, "")}/${sub.replace(/^\/+/, "")}`;
  const normalized = `/${combined.replace(/^\/+/, "")}`.replace(/\/+$/, "") ||
    "/";
  return normalized;
}

/**
 * Extract all named param names from a pattern (runtime, not type-level).
 * E.g. "/users/:id/posts/:pid?" → ["id", "pid"]
 */
export function extractParamNames(pattern: string): string[] {
  const names: string[] = [];
  for (const segment of pattern.split("/")) {
    if (segment.startsWith(":")) {
      names.push(segment.slice(1).replace(/\?$/, ""));
    } else if (segment === "*") {
      names.push("*");
    }
  }
  return names;
}

/**
 * Convert a route pattern to a regex + ordered param name list.
 *
 * Rules:
 * - `:name` → named capture `([^/]+)`
 * - `:name?` → optional named capture `(?:([^/]+))?` (preceding slash also optional)
 * - `*` (trailing) → wildcard capture `(.*)`
 */
export function buildRouteRegex(
  pattern: string,
): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const segments = pattern.split("/").filter((s) => s !== "");

  let regexStr = "";

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    if (seg === "*") {
      paramNames.push("*");
      regexStr += "/(.*)";
    } else if (seg.startsWith(":")) {
      const isOptional = seg.endsWith("?");
      const name = seg.slice(1).replace(/\?$/, "");
      paramNames.push(name);
      if (isOptional) {
        regexStr += `(?:/([^/]+))?`;
      } else {
        regexStr += `/([^/]+)`;
      }
    } else {
      regexStr += `/${escapeRegex(seg)}`;
    }
  }

  // Empty pattern → root
  if (regexStr === "") regexStr = "/";

  return {
    regex: new RegExp(`^${regexStr}$`),
    paramNames,
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
