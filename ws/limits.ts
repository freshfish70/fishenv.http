/** Per-connection rate limiting and per-route connection counting. */

/**
 * Classic token bucket: `capacity` tokens, refilled continuously at
 * `capacity / perMs`. Allows short bursts up to `capacity`.
 */
export class TokenBucket {
  readonly #capacity: number;
  readonly #ratePerMs: number;
  readonly #now: () => number;
  #tokens: number;
  #last: number;

  constructor(capacity: number, perMs: number, now = () => performance.now()) {
    if (!(capacity > 0) || !(perMs > 0)) {
      throw new Error("rateLimit: messages and perMs must be positive");
    }
    this.#capacity = capacity;
    this.#ratePerMs = capacity / perMs;
    this.#now = now;
    this.#tokens = capacity;
    this.#last = now();
  }

  /** Consume one token; `false` if the bucket is empty. */
  take(): boolean {
    const now = this.#now();
    this.#tokens = Math.min(
      this.#capacity,
      this.#tokens + (now - this.#last) * this.#ratePerMs,
    );
    this.#last = now;
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}

export interface WsConnectionLimit<A> {
  /** Max open sockets on this route. Rejected with `503`. */
  total?: number;
  /** Max open sockets per key (e.g. user id). Rejected with `429`. */
  perKey?: { key: (args: A) => string; max: number };
}

/**
 * Open-socket counters for one route. Checked before the upgrade (cheap
 * rejection) and re-checked on open, because concurrent handshakes can both
 * pass the first check — counting only real opens means nothing can leak.
 */
export class ConnectionCounter {
  #total = 0;
  readonly #byKey = new Map<string, number>();

  get total(): number {
    return this.#total;
  }

  count(key: string): number {
    return this.#byKey.get(key) ?? 0;
  }

  /** Register an open socket; returns the release fn (idempotent). */
  acquire(key: string | null): () => void {
    this.#total++;
    if (key != null) this.#byKey.set(key, this.count(key) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#total--;
      if (key == null) return;
      const next = this.count(key) - 1;
      if (next <= 0) this.#byKey.delete(key);
      else this.#byKey.set(key, next);
    };
  }
}
