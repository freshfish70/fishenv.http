/**
 * Shared WebSocket types, close codes and error → close-code mapping.
 * Deliberately free of class references from other ws modules so everything
 * can import from here without a cycle.
 */

import { HttpError, type UpgradedSocket } from "../core/index.ts";

// ── Close codes ──────────────────────────────────────────────────────────

export const WsCloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  /** Rate limit, protocol violation, invalid payload. */
  PolicyViolation: 1008,
  MessageTooBig: 1009,
  InternalError: 1011,
  /** Backpressure / overload. */
  TryAgainLater: 1013,
  /** `socket.expireAt()` reached. */
  SessionExpired: 4001,
} as const;

/** Close reasons are limited to 123 UTF-8 bytes by RFC 6455. */
export const MAX_CLOSE_REASON_BYTES = 123;

/** Throw from any handler to close the socket with a specific code. */
export class WsCloseError extends Error {
  readonly code: number;

  constructor(code: number, reason = "") {
    super(reason);
    this.name = "WsCloseError";
    this.code = code;
  }
}

/** The client sent something that violates the expected protocol. */
export class WsProtocolError extends WsCloseError {
  constructor(reason = "Protocol violation") {
    super(WsCloseCode.PolicyViolation, reason);
    this.name = "WsProtocolError";
  }
}

/**
 * Map a thrown value to a close frame. `HttpError`s become `4000 + status`
 * with their public message; anything unknown becomes `1011` with a generic
 * reason (the real message is only exposed in development).
 */
export function closeFrameFor(
  err: unknown,
  development = false,
): { code: number; reason: string } {
  if (err instanceof WsCloseError) {
    return { code: err.code, reason: truncateReason(err.message) };
  }
  if (err instanceof HttpError && err.status >= 100 && err.status <= 999) {
    return { code: 4000 + err.status, reason: truncateReason(err.message) };
  }
  const reason =
    development && err instanceof Error ? err.message : "Internal Error";
  return { code: WsCloseCode.InternalError, reason: truncateReason(reason) };
}

/** Truncate to {@link MAX_CLOSE_REASON_BYTES} without splitting a code point. */
export function truncateReason(reason: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(reason).byteLength <= MAX_CLOSE_REASON_BYTES) {
    return reason;
  }
  let out = "";
  let bytes = 0;
  for (const char of reason) {
    const size = encoder.encode(char).byteLength;
    if (bytes + size > MAX_CLOSE_REASON_BYTES) break;
    out += char;
    bytes += size;
  }
  return out;
}

// ── Handler-facing types ─────────────────────────────────────────────────

/** Return value is ignored; a returned promise is awaited only for error logging. */
export type WsCleanupFn = () => unknown;

/**
 * - `sent` — written (or queued below the backpressure limit)
 * - `backpressure` — queued, but the socket is over its buffer limit
 * - `dropped` — not sent (Bun dropped it)
 * - `closed` — the socket is gone
 */
export type WsSendResult = "sent" | "backpressure" | "dropped" | "closed";

/** Whatever Bun's `ServerWebSocket.send()` accepts (string, buffers, Blob). */
export type WsSendable = Parameters<UpgradedSocket["send"]>[0];

export interface WsRateLimit {
  /** Messages allowed per window (also the burst size). */
  messages: number;
  /** Window length in ms. */
  perMs: number;
  /** Default `"close"` → `1008`. `"drop"` silently discards excess messages. */
  onExceed?: "close" | "drop";
}

export interface WsConnectionOptions {
  /** Per-route inbound limit in bytes; must be ≤ the server-wide limit. */
  maxMessageSize?: number;
  rateLimit?: WsRateLimit;
  /** Messages buffered while an async handler sets up. Default 256. */
  maxQueuedMessages?: number;
  /** Include error messages in close reasons. Set from `serve({ development })`. */
  development?: boolean;
}

export const DEFAULT_MAX_QUEUED_MESSAGES = 256;
