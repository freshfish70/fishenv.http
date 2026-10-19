/**
 * Cross-process fan-out seam shared by `@fishenv/http/sse` and
 * `@fishenv/http/ws`. One adapter (Redis pub/sub, NATS, Postgres LISTEN…)
 * serves both.
 */

import type { Logger } from "./router.ts";

/** Every message carries the node that published it, for echo suppression. */
export interface TransportEnvelope {
  origin: string;
}

/** Messages must be JSON-serializable. */
export interface Transport<M extends TransportEnvelope = TransportEnvelope> {
  publish(message: M): void | Promise<void>;
  subscribe(onMessage: (message: M) => void): () => void;
}

export interface TransportBridge<M extends TransportEnvelope> {
  /** Random per-process id stamped into `origin`. */
  readonly nodeId: string;
  /** Stamp `origin` and publish; failures are logged, never thrown. */
  publish(message: Omit<M, "origin">): void;
  /** Detach from the transport. Idempotent. */
  close(): void;
}

/**
 * Wrap a (possibly absent) transport with the bookkeeping every hub needs:
 * a node id, dropping our own echoes, and logging publish failures so a
 * flaky broker can never break a local send.
 */
export function createTransportBridge<M extends TransportEnvelope>(
  transport: Transport<M> | undefined,
  onRemote: (message: M) => void,
  opts: { label?: string; logger?: Pick<Logger, "error"> } = {},
): TransportBridge<M> {
  const nodeId = crypto.randomUUID();
  const label = opts.label ?? "[fishenv.http]";
  const logger = opts.logger ?? console;
  const fail = (err: unknown) =>
    logger.error(`${label} transport publish failed:`, err);

  let unsubscribe = transport?.subscribe((message) => {
    if (message.origin === nodeId) return;
    try {
      onRemote(message);
    } catch (err) {
      logger.error(`${label} transport message handler failed:`, err);
    }
  });

  return {
    nodeId,
    publish(message) {
      if (transport == null) return;
      try {
        const result = transport.publish({ ...message, origin: nodeId } as M);
        if (result instanceof Promise) result.catch(fail);
      } catch (err) {
        fail(err);
      }
    },
    close() {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}

/**
 * In-process transport: every subscriber sees every message. Useful for
 * tests and for wiring several hubs together in one process.
 */
export function createMemoryTransport<
  M extends TransportEnvelope = TransportEnvelope,
>(): Transport<M> {
  const subscribers = new Set<(message: M) => void>();
  return {
    publish(message) {
      // Clone through JSON to catch non-serializable payloads early, like a
      // real broker would.
      const copy = JSON.parse(JSON.stringify(message)) as M;
      for (const fn of [...subscribers]) fn(copy);
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}
