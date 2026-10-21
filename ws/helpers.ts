/** Handshake helpers usable from custom handlers and middleware. */

import { HttpError } from "../core/index.ts";

/** `426 Upgrade Required`, advertising the websocket upgrade. */
export class UpgradeRequiredError extends HttpError {
  constructor(message = "Upgrade Required") {
    super(426, message);
  }

  override get code(): string {
    return "upgrade_required";
  }

  override toResponse(development = false): Response {
    const res = super.toResponse(development);
    res.headers.set("Upgrade", "websocket");
    res.headers.set("Connection", "Upgrade");
    return res;
  }
}

function hasToken(header: string | null, token: string): boolean {
  if (header == null) return false;
  return header.split(",").some((part) => part.trim().toLowerCase() === token);
}

/** RFC 6455 §4.2.1 opening-handshake checks. */
export function isWebSocketUpgrade(req: Request): boolean {
  return (
    req.method === "GET" &&
    hasToken(req.headers.get("upgrade"), "websocket") &&
    hasToken(req.headers.get("connection"), "upgrade") &&
    req.headers.get("sec-websocket-version") === "13" &&
    (req.headers.get("sec-websocket-key") ?? "") !== ""
  );
}

/** Subprotocols the client offered, in its order. */
export function requestedProtocols(req: Request): string[] {
  const header = req.headers.get("sec-websocket-protocol");
  if (header == null) return [];
  return header
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
}

/**
 * Pick the first of the server's `supported` protocols (server preference
 * order) that the client offered; `null` if none match.
 */
export function negotiateProtocol(
  req: Request,
  supported: readonly string[],
): string | null {
  const offered = new Set(requestedProtocols(req));
  return supported.find((p) => offered.has(p)) ?? null;
}
