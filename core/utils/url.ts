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
    }
  }
  return names;
}

/**
 * Convert a route pattern to a regex + ordered param name list.
 *
 * Rules:
 * - `:name`  → named capture `([^/]+)`
 * - `:name?` → optional named capture `(?:/([^/]+))?`
 * - `*`      → glob within a segment (`[^/]*`)
 * - `**`     → glob across path segments
 * - `{a,b}`  → alternation `(?:a|b)`
 */
export function buildRouteRegex(
  pattern: string,
): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const segments = pattern.split("/").filter((s) => s !== "");

  let regexStr = "";

  for (const seg of segments) {
    if (seg.startsWith(":")) {
      const isOptional = seg.endsWith("?");
      const name = seg.slice(1).replace(/\?$/, "");
      paramNames.push(name);

      if (isOptional) {
        regexStr += `(?:/([^/]+))?`;
      } else {
        regexStr += `/([^/]+)`;
      }
      continue;
    }

    if (seg === "**") {
      regexStr += `(?:/.*)?`;
      continue;
    }

    regexStr += `/${globSegmentToRegex(seg)}`;
  }

  // Empty pattern → root
  if (regexStr === "") regexStr = "/";

  return {
    regex: new RegExp(`^${regexStr}$`),
    paramNames,
  };
}

function globSegmentToRegex(segment: string): string {
  let out = "";
  let i = 0;

  while (i < segment.length) {
    const ch = segment[i];

    if (ch === "*") {
      out += "[^/]*";
      i++;
      continue;
    }

    if (ch === "{") {
      const end = findClosingBrace(segment, i);
      if (end === -1) {
        out += "\\{";
        i++;
        continue;
      }

      const body = segment.slice(i + 1, end);
      const parts = splitBraceParts(body).map((part) =>
        globLiteralToRegex(part)
      );
      out += parts.length > 0 ? `(?:${parts.join("|")})` : "\\{\\}";
      i = end + 1;
      continue;
    }

    out += escapeRegex(ch);
    i++;
  }

  return out;
}

function globLiteralToRegex(part: string): string {
  let out = "";

  for (const ch of part) {
    if (ch === "*") {
      out += "[^/]*";
    } else {
      out += escapeRegex(ch);
    }
  }

  return out;
}

function findClosingBrace(str: string, start: number): number {
  for (let i = start + 1; i < str.length; i++) {
    if (str[i] === "}") return i;
  }
  return -1;
}

function splitBraceParts(body: string): string[] {
  return body.split(",").map((part) => part.trim()).filter((part) =>
    part.length > 0
  );
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
