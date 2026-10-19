/** A lazily decoded inbound WebSocket message. */

import { WsProtocolError } from "./types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Bun delivers text frames as `string` and binary frames as `Buffer`; this
 * wraps both without forcing a decode until the handler asks for one.
 */
export class WsMessage {
  readonly #raw: string | Uint8Array;
  #size?: number;

  constructor(raw: string | Uint8Array) {
    this.#raw = raw;
  }

  get isBinary(): boolean {
    return typeof this.#raw !== "string";
  }

  /** Size in bytes (UTF-8 for text frames). */
  get size(): number {
    if (this.#size == null) {
      this.#size =
        typeof this.#raw === "string"
          ? Buffer.byteLength(this.#raw, "utf8")
          : this.#raw.byteLength;
    }
    return this.#size;
  }

  /** The original value Bun delivered. */
  get raw(): string | Uint8Array {
    return this.#raw;
  }

  /** Text content. Binary frames must hold valid UTF-8. */
  text(): string {
    if (typeof this.#raw === "string") return this.#raw;
    try {
      return decoder.decode(this.#raw);
    } catch {
      throw new WsProtocolError("Invalid UTF-8");
    }
  }

  bytes(): Uint8Array {
    return typeof this.#raw === "string"
      ? encoder.encode(this.#raw)
      : this.#raw;
  }

  /** Parse as JSON; malformed input throws a {@link WsProtocolError} (→ `1008`). */
  json<T = unknown>(): T {
    const text = this.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new WsProtocolError("Invalid JSON");
    }
  }
}
