/** Keyed registry of live connections — the seam for targeted (non-broadcast) sends. */

import type { SseConnection } from "./connection.ts";
import type { SseEventOptions, SseHubOptions, SseTransport } from "./types.ts";

/**
 * Connections keyed by an application identifier (user id, tenant id, document
 * id…). One key maps to many connections.
 *
 * Subclass it to get a DI token:
 * ```ts
 * class UserEvents extends SseHub {}
 * ```
 */
export class SseHub {
  readonly #byKey = new Map<string, Set<SseConnection>>();
  readonly #nodeId: string = crypto.randomUUID();
  readonly #transport?: SseTransport;
  #unsubscribe?: () => void;

  constructor(options: SseHubOptions = {}) {
    this.#transport = options.transport;
    this.#unsubscribe = options.transport?.subscribe((message) => {
      if (message.origin === this.#nodeId) return;
      this.#deliver(message.key, message.data, {
        event: message.event,
        id: message.id,
        retry: message.retry,
      });
    });
  }

  /** Register a connection. Returns an unregister fn; also auto-removes on close. */
  add(key: string, connection: SseConnection): () => void {
    let set = this.#byKey.get(key);
    if (set == null) {
      set = new Set();
      this.#byKey.set(key, set);
    }
    set.add(connection);

    const remove = () => {
      const current = this.#byKey.get(key);
      if (current == null) return;
      current.delete(connection);
      if (current.size === 0) this.#byKey.delete(key);
    };

    connection.onClose(remove);
    return remove;
  }

  /** Push to every connection registered under `key`. Returns local delivery count. */
  send(key: string, data: unknown, opts?: SseEventOptions): number {
    this.#publish(key, data, opts);
    return this.#deliver(key, data, opts);
  }

  /** Push to every connection under any of `keys`. Returns local delivery count. */
  sendMany(
    keys: Iterable<string>,
    data: unknown,
    opts?: SseEventOptions,
  ): number {
    let delivered = 0;
    for (const key of keys) delivered += this.send(key, data, opts);
    return delivered;
  }

  /** Push to every connection in this hub. Returns local delivery count. */
  broadcast(data: unknown, opts?: SseEventOptions): number {
    this.#publish(null, data, opts);
    return this.#deliver(null, data, opts);
  }

  /** Close every connection under `key`. Returns how many were closed. */
  close(key: string): number {
    const set = this.#byKey.get(key);
    if (set == null) return 0;
    const connections = [...set];
    for (const connection of connections) connection.close();
    return connections.length;
  }

  /** Close every connection and detach the transport subscription. */
  closeAll(): void {
    for (const set of [...this.#byKey.values()]) {
      for (const connection of [...set]) connection.close();
    }
    this.#byKey.clear();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  has(key: string): boolean {
    return (this.#byKey.get(key)?.size ?? 0) > 0;
  }

  /** Connection count for `key`, or the hub total when `key` is omitted. */
  count(key?: string): number {
    if (key != null) return this.#byKey.get(key)?.size ?? 0;
    let total = 0;
    for (const set of this.#byKey.values()) total += set.size;
    return total;
  }

  keys(): string[] {
    return [...this.#byKey.keys()];
  }

  connections(key: string): SseConnection[] {
    return [...(this.#byKey.get(key) ?? [])];
  }

  #deliver(key: string | null, data: unknown, opts?: SseEventOptions): number {
    const targets =
      key == null
        ? [...this.#byKey.values()].flatMap((set) => [...set])
        : [...(this.#byKey.get(key) ?? [])];

    let delivered = 0;
    for (const connection of targets) {
      if (connection.send(data, opts)) delivered++;
    }
    return delivered;
  }

  #publish(key: string | null, data: unknown, opts?: SseEventOptions): void {
    if (this.#transport == null) return;
    try {
      const result = this.#transport.publish({
        key,
        data,
        event: opts?.event,
        id: opts?.id,
        retry: opts?.retry,
        origin: this.#nodeId,
      });
      if (result instanceof Promise) {
        result.catch((err) =>
          console.error("[fishenv.sse] transport publish failed:", err),
        );
      }
    } catch (err) {
      console.error("[fishenv.sse] transport publish failed:", err);
    }
  }
}
