// ---------------------------------------------------------------------------
// CORS types
// ---------------------------------------------------------------------------

export interface CorsOptions {
  /**
   * Allowed origin(s).
   * - `'*'`          — allow all origins (when credentials is false)
   * - `string`       — allow a single explicit origin
   * - `string[]`     — allow any origin in the list
   * - `(origin) =>` — dynamic resolver; return the origin to allow or null/undefined to deny
   */
  origin: string | string[] | ((origin: string) => string | null | undefined);
  /** HTTP methods to allow. Default: GET HEAD PUT POST DELETE PATCH */
  allowMethods?: string[];
  /**
   * Headers to allow. Default: [] — when empty the middleware echoes the
   * request's Access-Control-Request-Headers value (wildcard-like behaviour).
   */
  allowHeaders?: string[];
  /** Headers to expose to the browser. Default: [] */
  exposeHeaders?: string[];
  /** Whether to include credentials. Default: false */
  credentials?: boolean;
  /** Max-age for preflight cache in seconds. Default: not set */
  maxAge?: number;
}

// ---------------------------------------------------------------------------
// Compiled CORS handle
// ---------------------------------------------------------------------------

export interface CompiledCors {
  /**
   * Build and return a 204 preflight response.
   * Always returns a Response — callers decide whether to use it based on the
   * request method being OPTIONS.
   */
  preflight(req: Request): Response;

  /**
   * Clone the response (if needed) and inject the CORS response-phase headers:
   * Access-Control-Allow-Origin, Access-Control-Allow-Credentials,
   * Access-Control-Expose-Headers, Vary.
   */
  applyTo(req: Request, res: Response): Response;
}

// ---------------------------------------------------------------------------
// buildCors
// ---------------------------------------------------------------------------

const DEFAULT_ALLOW_METHODS = ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH"];

export function buildCors(options: CorsOptions): CompiledCors {
  const {
    origin,
    allowMethods = DEFAULT_ALLOW_METHODS,
    allowHeaders = [],
    exposeHeaders = [],
    credentials = false,
    maxAge,
  } = options;

  // Build a synchronous origin resolver -----------------------------------
  function resolveOrigin(requestOrigin: string): string | null {
    if (typeof origin === "function") {
      return origin(requestOrigin) ?? null;
    }
    if (origin === "*") {
      // The spec forbids Access-Control-Allow-Origin: * together with
      // Access-Control-Allow-Credentials: true — reflect the request origin.
      return credentials ? requestOrigin || null : "*";
    }
    if (Array.isArray(origin)) {
      return origin.includes(requestOrigin) ? requestOrigin : null;
    }
    // Single explicit origin string
    return origin === requestOrigin ? requestOrigin : null;
  }

  // Whether to add Vary: Origin -------------------------------------------
  function needsVary(): boolean {
    // When the effective origin is always literal '*' (no credentials, no
    // dynamic/list/single origin), Vary is unnecessary.
    return credentials || origin !== "*";
  }

  // ── preflight -----------------------------------------------------------
  function preflight(req: Request): Response {
    const requestOrigin = req.headers.get("origin") ?? "";
    const allowed = resolveOrigin(requestOrigin);

    const headers = new Headers();

    if (allowed) {
      headers.set("Access-Control-Allow-Origin", allowed);
    }
    if (credentials) {
      headers.set("Access-Control-Allow-Credentials", "true");
    }
    if (needsVary()) {
      headers.set("Vary", "Origin");
    }
    if (maxAge != null) {
      headers.set("Access-Control-Max-Age", String(maxAge));
    }
    if (allowMethods.length) {
      headers.set("Access-Control-Allow-Methods", allowMethods.join(", "));
    }

    // Allowed headers: use configured list or echo the request header
    let effectiveAllowHeaders = allowHeaders;
    if (!effectiveAllowHeaders.length) {
      const requested = req.headers.get("access-control-request-headers");
      if (requested) {
        effectiveAllowHeaders = requested.split(/\s*,\s*/);
      }
    }
    if (effectiveAllowHeaders.length) {
      headers.set(
        "Access-Control-Allow-Headers",
        effectiveAllowHeaders.join(", "),
      );
      // Vary on this header when it was echoed from the request
      if (!allowHeaders.length) {
        const vary = headers.get("Vary");
        headers.set(
          "Vary",
          vary
            ? `${vary}, Access-Control-Request-Headers`
            : "Access-Control-Request-Headers",
        );
      }
    }

    return new Response(null, { status: 204, headers });
  }

  // ── applyTo -------------------------------------------------------------
  function applyTo(req: Request, res: Response): Response {
    const requestOrigin = req.headers.get("origin") ?? "";
    const allowed = resolveOrigin(requestOrigin);

    // Nothing to add if origin is not allowed
    if (!allowed) return res;

    // Clone response so we can safely mutate headers
    const next = new Response(res.body, res);

    next.headers.set("Access-Control-Allow-Origin", allowed);

    if (credentials) {
      next.headers.set("Access-Control-Allow-Credentials", "true");
    }
    if (exposeHeaders.length) {
      next.headers.set(
        "Access-Control-Expose-Headers",
        exposeHeaders.join(", "),
      );
    }
    if (needsVary()) {
      // Append rather than set to preserve any existing Vary value
      const existing = next.headers.get("Vary");
      next.headers.set("Vary", existing ? `${existing}, Origin` : "Origin");
    }

    return next;
  }

  return { preflight, applyTo };
}
