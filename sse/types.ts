/**
 * Shared SSE data types. Deliberately free of class references so every other
 * module in this package can import from here without a cycle.
 */

export interface SseEventOptions {
  /** `event:` field — the client-side listener name. Defaults to `message`. */
  event?: string;
  /** `id:` field — echoed back by the browser as `Last-Event-ID` on reconnect. */
  id?: string;
  /** `retry:` field — reconnection delay in milliseconds. */
  retry?: number;
}

/** Return value is ignored; a returned promise is awaited only for error logging. */
export type SseCleanupFn = () => unknown;

/** What to do when a client is too slow to drain the send buffer. */
export type SseOverflowPolicy = "close" | "drop";

export interface SseConnectionOptions {
  /** Send a `:` comment every N ms. Also how dead sockets get detected. */
  keepaliveMs?: number;
  /** Initial `retry:` hint sent as soon as the stream opens. */
  retryMs?: number;
  /** Send-buffer size in bytes before the overflow policy kicks in. */
  highWaterMark?: number;
  /** Default `"close"` — a stalled client is dropped and reconnects on its own. */
  onOverflow?: SseOverflowPolicy;
}

/** Cross-process fan-out envelope. Must be JSON-serializable. */
export interface SseTransportMessage {
  /** `null` means broadcast to every connection. */
  key: string | null;
  data: unknown;
  event?: string;
  id?: string;
  retry?: number;
  /** Node that published it — used to suppress echo back to the sender. */
  origin: string;
}

/** Seam for multi-instance deployments (Redis pub/sub, NATS, Postgres LISTEN…). */
export interface SseTransport {
  publish(message: SseTransportMessage): void | Promise<void>;
  subscribe(onMessage: (message: SseTransportMessage) => void): () => void;
}

export interface SseHubOptions {
  transport?: SseTransport;
}
