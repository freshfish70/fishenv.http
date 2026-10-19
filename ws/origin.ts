/**
 * Cross-Site WebSocket Hijacking (CSWSH) protection.
 *
 * Browsers attach cookies to cross-origin WebSocket handshakes and CORS does
 * not apply to them, so the `Origin` header is the only thing stopping a
 * hostile page from opening an authenticated socket. Requests *without* an
 * `Origin` (curl, native apps, servers) can't carry ambient browser
 * credentials and are allowed.
 */

import type { CorsOptions } from "../core/index.ts";

export type OriginPredicate = (
  origin: string,
  req: Request,
) => boolean | Promise<boolean>;

export type OriginSource =
  /** `Origin` host equals the `Host` header. */
  | "same-origin"
  /** Disable the check. Logged once at build. */
  | "any"
  /** Exact origin (`"https://app.example.com"`) or a leftmost wildcard (`"https://*.example.com"`). */
  | string
  /** Tested against the normalized origin; anchored automatically. */
  | RegExp
  | OriginPredicate;

export interface OriginPolicy {
  /** `true` if the handshake may proceed. */
  check(req: Request): boolean | Promise<boolean>;
  /** Whether the policy is `"any"` (no protection). */
  readonly allowsAny: boolean;
}

type Matcher = (
  origin: URL | null,
  raw: string,
  req: Request,
) => boolean | Promise<boolean>;

const DEFAULT_PORTS: Record<string, string> = {
  "http:": "80",
  "https:": "443",
  "ws:": "80",
  "wss:": "443",
};

/** `scheme://host[:port]`, lowercased, default ports dropped. */
function normalize(url: URL): string {
  return `${url.protocol}//${url.host}`.toLowerCase();
}

function parseOrigin(raw: string): URL | null {
  if (raw === "null") return null;
  try {
    const url = new URL(raw);
    // A real Origin header never has a path, query, fragment or userinfo.
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

/** Host header → `host[:port]` with any default port removed. */
function normalizeHost(host: string): string {
  const lower = host.toLowerCase().replace(/\.$/, "");
  const match = /^(.*?)(?::(\d+))?$/.exec(lower);
  if (match == null) return lower;
  const [, name, port] = match;
  if (port === "80" || port === "443" || port == null) return name ?? lower;
  return `${name}:${port}`;
}

function sameOrigin(origin: URL | null, _raw: string, req: Request): boolean {
  if (origin == null) return false;
  if (origin.protocol !== "http:" && origin.protocol !== "https:") return false;
  const host = req.headers.get("host");
  if (host == null) return false;
  return normalizeHost(origin.host) === normalizeHost(host);
}

function compileString(source: string): Matcher {
  const wildcard = /^([a-z][a-z0-9+.-]*):\/\/\*\.([^/:*]+)(?::(\d+))?$/i.exec(
    source,
  );
  if (wildcard) {
    const [, scheme, domain, port] = wildcard;
    const protocol = `${scheme!.toLowerCase()}:`;
    const suffix = `.${domain!.toLowerCase()}`;
    const wantPort = port ?? DEFAULT_PORTS[protocol] ?? "";
    return (origin) => {
      if (origin == null || origin.protocol !== protocol) return false;
      const gotPort = origin.port || DEFAULT_PORTS[origin.protocol] || "";
      if (gotPort !== wantPort) return false;
      const host = origin.hostname.toLowerCase();
      // Require at least one label before the suffix: "*.example.com"
      // matches "a.example.com" but not "example.com" or "evilexample.com".
      return host.endsWith(suffix) && host.length > suffix.length;
    };
  }

  if (source.includes("*")) {
    throw new Error(
      `Invalid origin "${source}": only a leftmost "*." wildcard is supported`,
    );
  }
  if (source === "null") {
    return (_origin, raw) => raw === "null";
  }
  const parsed = parseOrigin(source);
  if (
    parsed == null ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `Invalid origin "${source}": expected "scheme://host[:port]"`,
    );
  }
  const expected = normalize(parsed);
  return (origin) => origin != null && normalize(origin) === expected;
}

function compileRegExp(source: RegExp): Matcher {
  const body = source.source;
  const anchored = new RegExp(
    `^(?:${body})$`,
    source.flags.replace(/[gy]/g, ""),
  );
  return (origin, raw) =>
    anchored.test(origin == null ? raw : normalize(origin));
}

/**
 * Compile origin sources into a policy. An empty list means `"same-origin"`.
 * Throws on malformed sources so mistakes surface at startup.
 */
export function createOriginPolicy(
  sources: readonly OriginSource[],
): OriginPolicy {
  if (sources.includes("any")) {
    return { check: () => true, allowsAny: true };
  }

  const matchers: Matcher[] = (sources.length ? sources : ["same-origin"]).map(
    (source): Matcher => {
      if (source === "same-origin") return sameOrigin;
      if (typeof source === "string") return compileString(source);
      if (source instanceof RegExp) return compileRegExp(source);
      return (_origin, raw, req) => source(raw, req);
    },
  );

  return {
    allowsAny: false,
    check(req) {
      const raw = req.headers.get("origin");
      if (raw == null) return true; // non-browser client
      const origin = parseOrigin(raw);

      const pending: Promise<boolean>[] = [];
      for (const matcher of matchers) {
        const result = matcher(origin, raw, req);
        if (result === true) return true;
        if (result instanceof Promise) pending.push(result);
      }
      if (pending.length === 0) return false;
      return Promise.all(pending).then((results) => results.includes(true));
    },
  };
}

/**
 * Origin sources inherited from a root `cors()` config. `"*"` is *not*
 * inherited — a wildcard would disable CSWSH protection on cookie-authenticated
 * sockets — and is reported via `wildcard` so the caller can warn.
 */
export function originSourcesFromCors(cors: CorsOptions | null): {
  sources: OriginSource[];
  wildcard: boolean;
} {
  if (cors == null) return { sources: [], wildcard: false };
  const { origin } = cors;
  if (origin === "*") return { sources: [], wildcard: true };
  if (typeof origin === "function") {
    return { sources: [(o) => origin(o) != null], wildcard: false };
  }
  const list = Array.isArray(origin) ? origin : [origin];
  return {
    sources: list.filter((o) => o !== "*"),
    wildcard: list.includes("*"),
  };
}
