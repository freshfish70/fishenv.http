/** Shared helpers for tests that talk to a real `serve()` over WebSocket. */

export interface Closed {
  code: number;
  reason: string;
}

/**
 * A WHATWG `WebSocket` with a buffered inbox, so tests can `await next()`
 * without racing the `message` event.
 */
export class TestClient {
  readonly ws: WebSocket;
  readonly closed: Promise<Closed>;
  readonly #inbox: (string | ArrayBuffer)[] = [];
  readonly #waiters: ((msg: string | ArrayBuffer) => void)[] = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", (event) => {
      const waiter = this.#waiters.shift();
      if (waiter) waiter(event.data);
      else this.#inbox.push(event.data);
    });
    this.closed = new Promise((resolve) => {
      ws.addEventListener("close", (e) =>
        resolve({ code: e.code, reason: e.reason }),
      );
    });
  }

  /** Next message, in arrival order. */
  next(timeoutMs = 2000): Promise<string | ArrayBuffer> {
    const queued = this.#inbox.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for a message")),
        timeoutMs,
      );
      this.#waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  async nextText(timeoutMs?: number): Promise<string> {
    const msg = await this.next(timeoutMs);
    if (typeof msg !== "string") throw new Error("expected a text message");
    return msg;
  }

  async nextJson<T = unknown>(timeoutMs?: number): Promise<T> {
    return JSON.parse(await this.nextText(timeoutMs)) as T;
  }

  /** Messages received but not yet consumed. */
  get pending(): number {
    return this.#inbox.length;
  }

  send(data: string | BufferSource | Blob): void {
    this.ws.send(data);
  }

  sendJson(value: unknown): void {
    this.ws.send(JSON.stringify(value));
  }

  close(code?: number, reason?: string): Promise<Closed> {
    this.ws.close(code, reason);
    return this.closed;
  }
}

/**
 * Open a socket and wait for the handshake. Rejects (with the close info)
 * if the server refuses the upgrade.
 */
export function connect(
  url: string,
  protocols?: string | string[],
  init?: { headers?: Record<string, string> },
): Promise<TestClient> {
  // Bun's WebSocket accepts `headers` (e.g. a spoofed Origin) as an extension.
  const ws = init?.headers
    ? new WebSocket(url, {
        protocols,
        headers: init.headers,
      } as unknown as string[])
    : new WebSocket(url, protocols);
  const client = new TestClient(ws);
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(client), { once: true });
    ws.addEventListener("error", () => reject(new Error("handshake failed")), {
      once: true,
    });
  });
}

/** Resolve with the close info of a handshake the server must reject. */
export function connectRejected(
  url: string,
  protocols?: string | string[],
  init?: { headers?: Record<string, string> },
): Promise<"rejected" | "opened"> {
  return connect(url, protocols, init).then(
    (client) => {
      client.close();
      return "opened" as const;
    },
    () => "rejected" as const,
  );
}

export async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function wsUrl(server: { port: number }, path: string): string {
  return `ws://127.0.0.1:${server.port}${path}`;
}
