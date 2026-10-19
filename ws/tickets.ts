/**
 * Browser-safe handshake authentication.
 *
 * Browsers can't set `Authorization` on a WebSocket handshake. Instead of
 * putting a long-lived token in the URL (where it lands in logs, proxies and
 * history), an authenticated HTTP call mints a short-lived **single-use**
 * ticket, and the ws route redeems it:
 *
 * ```ts
 * class SocketTickets extends WsTickets<{ userId: string }> {}
 *
 * api.post("/ws-ticket").with(auth).handle(async ({ ctx, container }) =>
 *   Response.json({ ticket: await container.get(SocketTickets).issue({ userId: ctx.user.id }) }));
 *
 * api.ws("/live").with(SocketTickets.middleware()).handle(({ ctx }) => ctx.ticket.userId);
 * // client: new WebSocket(`wss://host/live?ticket=${ticket}`)
 * ```
 */

import { timingSafeEqual } from "node:crypto";
import {
  type DIContainer,
  type MiddlewareFn,
  TooManyRequestsError,
  UnauthorizedError,
} from "../core/index.ts";
import { requestedProtocols } from "./helpers.ts";

/** Storage seam — use Redis (`SET PX` + `GETDEL`) for multi-instance setups. */
export interface TicketStore {
  set(id: string, value: string, ttlMs: number): void | Promise<void>;
  /** Atomically read *and delete*; `null`/`undefined` if absent or expired. */
  take(
    id: string,
  ): string | null | undefined | Promise<string | null | undefined>;
}

/** In-process store with lazy expiry and a hard size cap. */
export class MemoryTicketStore implements TicketStore {
  readonly #entries = new Map<string, { value: string; expires: number }>();
  readonly #maxSize: number;
  readonly #now: () => number;

  constructor(opts: { maxSize?: number; now?: () => number } = {}) {
    this.#maxSize = opts.maxSize ?? 100_000;
    this.#now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  set(id: string, value: string, ttlMs: number): void {
    if (this.#entries.size >= this.#maxSize) this.#sweep();
    if (this.#entries.size >= this.#maxSize) {
      throw new TooManyRequestsError("Too many outstanding tickets");
    }
    this.#entries.set(id, { value, expires: this.#now() + ttlMs });
  }

  take(id: string): string | null {
    const entry = this.#entries.get(id);
    if (entry == null) return null;
    this.#entries.delete(id);
    return entry.expires > this.#now() ? entry.value : null;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [id, entry] of this.#entries) {
      if (entry.expires <= now) this.#entries.delete(id);
    }
  }
}

export interface WsTicketsOptions {
  /** Ticket lifetime. Default 30 s. */
  ttlMs?: number;
  store?: TicketStore;
  /** Query parameter read by `middleware()`. Default `"ticket"`. */
  param?: string;
  /**
   * Bind tickets to a request property (e.g. `User-Agent`) to cut replay
   * value. Compared in constant time; a mismatch still consumes the ticket.
   */
  fingerprint?: (req: Request) => string;
}

/** 32 random bytes, base64url → 43 chars. */
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function newTicketId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

function digest(value: string): Buffer {
  return Buffer.from(new Bun.CryptoHasher("sha256").update(value).digest());
}

interface StoredTicket<T> {
  p: T;
  f?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: DI token constructor
type TicketsToken<T> = abstract new (...args: any[]) => WsTickets<T>;

/** Payloads must be JSON-serializable (stores hold strings). */
export class WsTickets<T = unknown> {
  readonly #ttlMs: number;
  readonly #store: TicketStore;
  readonly #param: string;
  readonly #fingerprint?: (req: Request) => string;

  constructor(options: WsTicketsOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 30_000;
    this.#store = options.store ?? new MemoryTicketStore();
    this.#param = options.param ?? "ticket";
    this.#fingerprint = options.fingerprint;
  }

  /** Mint a ticket. Pass the issuing request when using `fingerprint`. */
  async issue(payload: T, req?: Request): Promise<string> {
    const id = newTicketId();
    const record: StoredTicket<T> = { p: payload };
    if (this.#fingerprint != null) {
      if (req == null) {
        throw new Error("WsTickets.issue(): fingerprint requires the request");
      }
      record.f = digest(this.#fingerprint(req)).toString("base64");
    }
    await this.#store.set(id, JSON.stringify(record), this.#ttlMs);
    return id;
  }

  /** Consume a ticket. `null` if unknown, used, expired or mismatched. */
  async redeem(
    ticket: string | null | undefined,
    req?: Request,
  ): Promise<T | null> {
    if (ticket == null || !TICKET_PATTERN.test(ticket)) return null;
    const raw = await this.#store.take(ticket);
    if (raw == null) return null;

    let record: StoredTicket<T>;
    try {
      record = JSON.parse(raw) as StoredTicket<T>;
    } catch {
      return null;
    }

    if (record.f != null) {
      if (this.#fingerprint == null || req == null) return null;
      const expected = Buffer.from(record.f, "base64");
      const actual = digest(this.#fingerprint(req));
      if (
        expected.byteLength !== actual.byteLength ||
        !timingSafeEqual(expected, actual)
      ) {
        return null;
      }
    }
    return record.p;
  }

  /** Middleware that redeems `?ticket=` and adds `ctx.ticket`; `401` otherwise. */
  middleware(): MiddlewareFn<Record<string, unknown>, { ticket: T }> {
    return async ({ req }) => {
      const ticket = new URL(req.url).searchParams.get(this.#param);
      const payload = await this.redeem(ticket, req);
      if (payload == null) {
        throw new UnauthorizedError("Invalid or expired ticket");
      }
      return { ticket: payload };
    };
  }

  /**
   * Same as {@link WsTickets.middleware}, but resolves the instance from the
   * DI container on each request: `.with(SocketTickets.middleware())`.
   */
  static middleware<T>(
    this: TicketsToken<T>,
  ): MiddlewareFn<Record<string, unknown>, { ticket: T }> {
    return (ctx) => {
      const container = (ctx as { container?: DIContainer }).container;
      if (container == null) {
        throw new Error("WsTickets.middleware(): no DI container available");
      }
      // `this` is the subclass the method was called on — the DI token.
      // biome-ignore lint/complexity/noThisInStatic: intentional, see above
      return container.get(this).middleware()(ctx);
    };
  }
}

/**
 * Read a bearer token from `Sec-WebSocket-Protocol: bearer, <token>` — the
 * one header browsers *can* set on a handshake. Less preferred than tickets
 * (the token is long-lived), but useful for native clients and dev tools.
 *
 * The scheme must be offered **first**: Bun echoes the first offered
 * subprotocol when the route doesn't negotiate, so this guarantees the
 * token is never reflected back. Pair it with `.protocols(["bearer"])`.
 */
export function bearerFromProtocol(
  scheme = "bearer",
): MiddlewareFn<Record<string, unknown>, { bearerToken: string }> {
  return ({ req }) => {
    const [first, token, ...rest] = requestedProtocols(req);
    if (first !== scheme || token == null || token === "" || rest.length > 0) {
      throw new UnauthorizedError("Missing bearer subprotocol");
    }
    return { bearerToken: token };
  };
}
