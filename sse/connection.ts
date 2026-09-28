/** A single live SSE stream, usable beyond the lifetime of its route handler. */

import { encodeSseComment, encodeSseEvent, encodeSseRetry } from "./encode.ts";
import type {
  SseCleanupFn,
  SseConnectionOptions,
  SseEventOptions,
  SseOverflowPolicy,
} from "./types.ts";

const encoder = new TextEncoder();

export const DEFAULT_HIGH_WATER_MARK = 64 * 1024;

/**
 * Every method is a no-op once the connection is closed, so a stale reference
 * held by a service or registry can never throw.
 */
export class SseConnection {
  /** Unique per connection; a user may hold several (one per tab/device). */
  readonly id: string = crypto.randomUUID();
  /** From the `Last-Event-ID` header, falling back to a `?lastEventId=` query param. */
  readonly lastEventId: string | null;
  readonly req: Request;

  #controller: ReadableStreamDefaultController<Uint8Array> | null;
  #highWaterMark: number;
  #overflow: SseOverflowPolicy;
  #closed = false;
  #closeCallbacks: SseCleanupFn[] = [];

  constructor(
    controller: ReadableStreamDefaultController<Uint8Array>,
    req: Request,
    options: SseConnectionOptions = {},
  ) {
    this.#controller = controller;
    this.req = req;
    this.#highWaterMark = options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
    this.#overflow = options.onOverflow ?? "close";
    this.lastEventId =
      req.headers.get("last-event-id") ??
      new URL(req.url).searchParams.get("lastEventId");
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Bytes queued but not yet flushed to the socket. */
  get bufferedBytes(): number {
    if (this.#closed || this.#controller == null) return 0;
    return this.#highWaterMark - (this.#controller.desiredSize ?? 0);
  }

  /** Returns `false` if the event was dropped because the connection is gone or saturated. */
  send(data: unknown, opts?: SseEventOptions): boolean {
    return this.#write(encodeSseEvent(data, opts));
  }

  /** Send a comment line — invisible to `EventSource`, used as a heartbeat. */
  comment(text = ""): boolean {
    return this.#write(encodeSseComment(text));
  }

  /** Tell the client how long to wait before reconnecting. */
  retry(ms: number): boolean {
    return this.#write(encodeSseRetry(ms));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;

    const controller = this.#controller;
    this.#controller = null;
    try {
      controller?.close();
    } catch {
      // Already closed or errored by the consumer — nothing to do.
    }

    const callbacks = this.#closeCallbacks;
    this.#closeCallbacks = [];
    for (const cb of callbacks) runCleanup(cb);
  }

  /** Runs immediately if the connection is already closed. */
  onClose(fn: SseCleanupFn): void {
    if (this.#closed) {
      runCleanup(fn);
      return;
    }
    this.#closeCallbacks.push(fn);
  }

  #write(frame: string): boolean {
    if (this.#closed || this.#controller == null) return false;

    if ((this.#controller.desiredSize ?? 0) <= 0) {
      if (this.#overflow === "close") this.close();
      return false;
    }

    try {
      this.#controller.enqueue(encoder.encode(frame));
      return true;
    } catch {
      this.close();
      return false;
    }
  }
}

/** @internal */
export function runCleanup(fn: SseCleanupFn): void {
  try {
    const result = fn();
    if (result instanceof Promise) {
      result.catch((err) =>
        console.error("[fishenv.sse] close callback rejected:", err),
      );
    }
  } catch (err) {
    console.error("[fishenv.sse] close callback threw:", err);
  }
}
