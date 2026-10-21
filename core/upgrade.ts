/**
 * Generic WebSocket upgrade plumbing for Bun — deliberately protocol-agnostic
 * so core never depends on `@fishenv/http/ws`.
 *
 * Bun upgrades from inside `fetch(req, server)`, but route handlers only see
 * `req` and must return a `Response`. A handler therefore *requests* an
 * upgrade (keyed by the `Request`, which survives CORS/HEAD response cloning)
 * and returns a placeholder; `serve()` — or {@link completeUpgrade} for a
 * hand-rolled `Bun.serve` — performs the actual upgrade.
 */

import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Logger } from "./router.ts";

export type UpgradedSocket = ServerWebSocket<SocketData>;

/** Per-socket lifecycle callbacks, dispatched through `ws.data`. */
export interface SocketHandlers {
  open?(ws: UpgradedSocket): void | Promise<void>;
  message?(ws: UpgradedSocket, message: string | Buffer): void | Promise<void>;
  close?(
    ws: UpgradedSocket,
    code: number,
    reason: string,
  ): void | Promise<void>;
  drain?(ws: UpgradedSocket): void;
}

export interface SocketData {
  readonly handlers: SocketHandlers;
  /** The server that owns this socket — needed for native `publish()`. */
  readonly server: Server<SocketData>;
  /** Owned by whoever requested the upgrade. */
  state: unknown;
}

export interface UpgradeIntent {
  handlers: SocketHandlers;
  state?: unknown;
  /** Extra handshake response headers, e.g. `Sec-WebSocket-Protocol`. */
  headers?: HeadersInit;
}

const pending = new WeakMap<Request, UpgradeIntent>();

/**
 * Ask the server to upgrade `req` once the response pipeline finishes.
 *
 * The returned `426` is only ever seen when no server performs the upgrade —
 * e.g. when calling `router.fetch()` directly in a unit test.
 */
export function requestUpgrade(req: Request, intent: UpgradeIntent): Response {
  pending.set(req, intent);
  return new Response("Upgrade Required", {
    status: 426,
    headers: { Upgrade: "websocket", Connection: "Upgrade" },
  });
}

/** Remove and return the pending upgrade for `req`, if any. */
export function takeUpgrade(req: Request): UpgradeIntent | undefined {
  const intent = pending.get(req);
  if (intent != null) pending.delete(req);
  return intent;
}

/**
 * Finish a request inside Bun's `fetch(req, server)`: performs a pending
 * upgrade (returning `undefined`, as Bun requires) or passes `res` through.
 */
export function completeUpgrade(
  req: Request,
  res: Response,
  server: Server<SocketData>,
): Response | undefined {
  const intent = takeUpgrade(req);
  if (intent == null) return res;

  const upgraded = server.upgrade(req, {
    data: { handlers: intent.handlers, server, state: intent.state },
    headers: intent.headers,
  });
  if (upgraded) return undefined;
  return new Response("WebSocket upgrade failed", { status: 400 });
}

// ── Server-wide socket options ───────────────────────────────────────────

/**
 * Server-global socket settings. Bun's own defaults are permissive (16 MB
 * frames and send buffers, slow consumers never dropped); these are not.
 */
export interface WsServerOptions {
  /** Max inbound message size in bytes. Default 64 KiB. */
  maxPayloadLength?: number;
  /** Max bytes buffered per socket before backpressure. Default 1 MiB. */
  backpressureLimit?: number;
  /** Close sockets that exceed `backpressureLimit`. Default `true`. */
  closeOnBackpressureLimit?: boolean;
  /** Seconds without traffic before a socket is closed. Default 120. */
  idleTimeout?: number;
  /** Send protocol pings so idle-but-alive sockets stay open. Default `true`. */
  sendPings?: boolean;
  /** `permessage-deflate`. Default `false` (decompression-bomb surface). */
  perMessageDeflate?: boolean;
}

export const DEFAULT_MAX_PAYLOAD_LENGTH = 64 * 1024;
export const DEFAULT_BACKPRESSURE_LIMIT = 1024 * 1024;

/** `1001 Going Away` — sent to every socket on graceful shutdown. */
export const CLOSE_GOING_AWAY = 1001;
/** `1011 Internal Error`. */
export const CLOSE_INTERNAL_ERROR = 1011;

export interface WebSocketRuntime {
  /** Pass as `websocket` to `Bun.serve`. */
  readonly websocket: WebSocketHandler<SocketData>;
  /** Number of sockets currently open on this server. */
  readonly size: number;
  /** Close every open socket, e.g. before `server.stop()`. */
  closeAll(code?: number, reason?: string): void;
}

/**
 * Build the single Bun `websocket` handler that dispatches every event to the
 * per-socket {@link SocketHandlers}. Also a last-resort guard: a handler that
 * throws or rejects is logged and its socket closed with `1011`.
 */
export function createWebSocketRuntime(
  options: WsServerOptions = {},
  logger?: Pick<Logger, "error">,
): WebSocketRuntime {
  const open = new Set<UpgradedSocket>();
  const log = logger ?? console;

  const guard = (
    ws: UpgradedSocket,
    event: string,
    run: () => void | Promise<void>,
  ) => {
    const fail = (err: unknown) => {
      log.error(`[fishenv.http] WebSocket ${event} handler failed:`, err);
      if (event !== "close") ws.close(CLOSE_INTERNAL_ERROR, "Internal Error");
    };
    try {
      const result = run();
      if (result instanceof Promise) result.catch(fail);
    } catch (err) {
      fail(err);
    }
  };

  const websocket: WebSocketHandler<SocketData> = {
    open(ws) {
      open.add(ws);
      guard(ws, "open", () => ws.data.handlers.open?.(ws));
    },
    message(ws, message) {
      guard(ws, "message", () => ws.data.handlers.message?.(ws, message));
    },
    close(ws, code, reason) {
      open.delete(ws);
      guard(ws, "close", () => ws.data.handlers.close?.(ws, code, reason));
    },
    drain(ws) {
      guard(ws, "drain", () => ws.data.handlers.drain?.(ws));
    },
    maxPayloadLength: options.maxPayloadLength ?? DEFAULT_MAX_PAYLOAD_LENGTH,
    backpressureLimit: options.backpressureLimit ?? DEFAULT_BACKPRESSURE_LIMIT,
    closeOnBackpressureLimit: options.closeOnBackpressureLimit ?? true,
    idleTimeout: options.idleTimeout ?? 120,
    sendPings: options.sendPings ?? true,
    perMessageDeflate: options.perMessageDeflate ?? false,
    publishToSelf: false,
  };

  return {
    websocket,
    get size() {
      return open.size;
    },
    closeAll(code = CLOSE_GOING_AWAY, reason = "Server shutting down") {
      for (const ws of [...open]) ws.close(code, reason);
    },
  };
}
