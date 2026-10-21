/** A single live WebSocket, usable beyond the lifetime of its route handler. */

import type { UpgradedSocket } from "../core/index.ts";
import type { WsMessage } from "./message.ts";
import {
  truncateReason,
  type WsCleanupFn,
  WsCloseCode,
  type WsSendable,
  type WsSendResult,
} from "./types.ts";

export type WsMessageListener = (message: WsMessage) => unknown;
export type WsCloseListener = (code: number, reason: string) => unknown;

/** setTimeout's max delay; longer expiries are chained. */
const MAX_TIMEOUT = 2 ** 31 - 1;

/**
 * Wraps Bun's `ServerWebSocket`. Every method is a no-op once the connection
 * is closed (or closing), so a stale reference held by a service or hub can
 * never throw.
 */
export class WsConnection {
  /** Unique per connection; a user may hold several (one per tab/device). */
  readonly id: string = crypto.randomUUID();
  /** The upgrade request (headers, URL). */
  readonly req: Request;
  /** Negotiated subprotocol, if any. */
  readonly protocol: string | null;
  /** Free-form per-connection state for the application. */
  data: Record<string, unknown> = {};

  readonly #ws: UpgradedSocket;
  readonly #onError: (err: unknown) => void;
  #state: "open" | "closing" | "closed" = "open";
  #closeInfo: { code: number; reason: string } | null = null;
  #messageListeners = new Set<WsMessageListener>();
  #drainListeners = new Set<() => void>();
  #closeListeners: WsCloseListener[] = [];
  #expiry: ReturnType<typeof setTimeout> | undefined;

  /** @internal Created by the ws route lifecycle. */
  constructor(
    ws: UpgradedSocket,
    req: Request,
    protocol: string | null,
    onError: (err: unknown) => void,
  ) {
    this.#ws = ws;
    this.req = req;
    this.protocol = protocol;
    this.#onError = onError;
  }

  /** `true` once `close()` was called or the peer disconnected. */
  get closed(): boolean {
    return this.#state !== "open";
  }

  get remoteAddress(): string {
    return this.#ws.remoteAddress;
  }

  /** Bytes queued but not yet flushed to the socket. */
  get bufferedBytes(): number {
    return this.#state === "closed" ? 0 : this.#ws.getBufferedAmount();
  }

  /** Escape hatch to Bun's socket. Native topics used here aren't namespaced. */
  get raw(): UpgradedSocket {
    return this.#ws;
  }

  send(data: WsSendable): WsSendResult {
    if (this.closed) return "closed";
    let status: number;
    try {
      status = this.#ws.send(data);
    } catch {
      return "closed";
    }
    if (status === -1) return "backpressure";
    if (status === 0) return "dropped";
    return "sent";
  }

  /** `JSON.stringify` + send. Throws on non-serializable values. */
  sendJson(value: unknown): WsSendResult {
    return this.send(JSON.stringify(value));
  }

  /** Graceful close. The reason is truncated to 123 bytes. */
  close(code: number = WsCloseCode.Normal, reason = ""): void {
    if (this.closed) return;
    this.#state = "closing";
    this.#clearExpiry();
    try {
      this.#ws.close(code, truncateReason(reason));
    } catch {
      // Invalid code or already torn down — make sure it really goes away.
      this.#ws.terminate();
    }
  }

  /**
   * Close with `4001 Session expired` at `when` (a `Date` or epoch ms) —
   * align it with the token/session lifetime so sockets don't outlive auth.
   * Calling again replaces the previous deadline.
   */
  expireAt(when: Date | number): void {
    if (this.closed) return;
    this.#clearExpiry();
    const deadline = typeof when === "number" ? when : when.getTime();
    const arm = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.close(WsCloseCode.SessionExpired, "Session expired");
        return;
      }
      this.#expiry = setTimeout(arm, Math.min(remaining, MAX_TIMEOUT));
    };
    arm();
  }

  /** Returns an unsubscribe fn. */
  onMessage(fn: WsMessageListener): () => void {
    if (this.#state === "closed") return () => {};
    this.#messageListeners.add(fn);
    return () => this.#messageListeners.delete(fn);
  }

  /** Runs exactly once, immediately if already closed. */
  onClose(fn: WsCloseListener | WsCleanupFn): void {
    if (this.#state === "closed") {
      const info = this.#closeInfo!;
      runCallback(() => fn(info.code, info.reason), this.#onError);
      return;
    }
    this.#closeListeners.push(fn);
  }

  /** Fires when a backpressured socket's buffer drains. */
  onDrain(fn: () => void): () => void {
    if (this.#state === "closed") return () => {};
    this.#drainListeners.add(fn);
    return () => this.#drainListeners.delete(fn);
  }

  // ── Lifecycle hooks (driven by the route lifecycle) ─────────────────

  /** @internal */
  _deliver(message: WsMessage): void {
    for (const listener of [...this.#messageListeners]) {
      if (this.closed) return;
      runCallback(() => listener(message), this.#onError);
    }
  }

  /** @internal */
  _drained(): void {
    for (const listener of [...this.#drainListeners]) {
      runCallback(listener, this.#onError);
    }
  }

  /** @internal Bun reported the socket closed. */
  _closed(code: number, reason: string): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#closeInfo = { code, reason };
    this.#clearExpiry();
    this.#messageListeners.clear();
    this.#drainListeners.clear();
    const listeners = this.#closeListeners;
    this.#closeListeners = [];
    for (const fn of listeners) {
      runCallback(() => fn(code, reason), this.#onError);
    }
  }

  #clearExpiry(): void {
    if (this.#expiry !== undefined) clearTimeout(this.#expiry);
    this.#expiry = undefined;
  }
}

/** Run a user callback; sync throws and rejections both go to `onError`. */
export function runCallback(
  fn: () => unknown,
  onError: (err: unknown) => void,
): void {
  try {
    const result = fn();
    if (result instanceof Promise) result.catch(onError);
  } catch (err) {
    onError(err);
  }
}
