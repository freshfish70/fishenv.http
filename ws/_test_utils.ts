/** Helpers for ws tests that run against a real `serve()`. */

import { afterEach } from "bun:test";
import {
  type TestClient as BaseClient,
  connect as baseConnect,
} from "../core/_test_utils.ts";
import {
  type HttpServer,
  type Logger,
  type Router,
  r,
  type ServeOptions,
  serve,
} from "../core/index.ts";
import { type WsRouter, withWs } from "./router.ts";

export {
  connect,
  connectRejected,
  TestClient,
  waitFor,
} from "../core/_test_utils.ts";

const running: HttpServer[] = [];

/** Registers an afterEach that stops every server started by {@link startServer}. */
export function useServers(): void {
  afterEach(async () => {
    for (const server of running.splice(0)) await server.stop(true);
  });
}

export interface TestServer {
  server: HttpServer;
  url(path: string): string;
  http(path: string): string;
}

// biome-ignore lint/suspicious/noExplicitAny: tests build routers of any context
export function startServer<R extends Router<any, Record<never, never>>>(
  app: R,
  options: ServeOptions = {},
): TestServer {
  const server = serve(app, {
    port: 0,
    hostname: "127.0.0.1",
    logger: silentLogger(),
    ...options,
  });
  running.push(server);
  return {
    server,
    url: (path) => `ws://127.0.0.1:${server.port}${path}`,
    http: (path) => `http://127.0.0.1:${server.port}${path}`,
  };
}

/** A fresh ws-enabled root router. */
export function wsApp(): Router<Record<never, never>, Record<never, never>> &
  WsRouter<Record<never, never>> {
  return withWs(r());
}

export interface RecordingLogger extends Logger {
  errors: unknown[][];
  warnings: string[];
}

export function silentLogger(): RecordingLogger {
  const errors: unknown[][] = [];
  const warnings: string[] = [];
  return {
    errors,
    warnings,
    error: (...args: unknown[]) => void errors.push(args),
    warn: (message: string) => void warnings.push(message),
    info() {},
  };
}

/** Headers of a valid RFC 6455 handshake, for `router.fetch` tests. */
export function handshakeHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    host: "localhost",
    upgrade: "websocket",
    connection: "Upgrade",
    "sec-websocket-version": "13",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    ...extra,
  };
}

export function handshake(
  path: string,
  extra: Record<string, string> = {},
): Request {
  return new Request(`http://localhost${path}`, {
    headers: handshakeHeaders(extra),
  });
}

// ── Channel protocol client ─────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: test frames are loosely typed
export type Frame = Record<string, any>;

/**
 * Speaks `fishenv.channels.v1`: buffers every server frame so tests can wait
 * for a specific one regardless of interleaving.
 */
export class ChannelClient {
  readonly raw: BaseClient;
  #frames: Frame[] = [];
  #waiters: { match: (f: Frame) => boolean; resolve: (f: Frame) => void }[] =
    [];
  #ref = 0;

  constructor(raw: BaseClient) {
    this.raw = raw;
    void this.#pump();
  }

  async #pump(): Promise<void> {
    for (;;) {
      let msg: string | ArrayBuffer;
      try {
        msg = await this.raw.next(60_000);
      } catch {
        return;
      }
      const frame = JSON.parse(String(msg)) as Frame;
      const i = this.#waiters.findIndex((w) => w.match(frame));
      if (i >= 0) this.#waiters.splice(i, 1)[0]!.resolve(frame);
      else this.#frames.push(frame);
    }
  }

  /** Wait for (and consume) the first frame matching `match`. */
  waitFrame(match: (f: Frame) => boolean, timeoutMs = 2000): Promise<Frame> {
    const i = this.#frames.findIndex(match);
    if (i >= 0) return Promise.resolve(this.#frames.splice(i, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for a frame")),
        timeoutMs,
      );
      this.#waiters.push({
        match,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  }

  /** Frames received but not consumed. */
  get unread(): Frame[] {
    return [...this.#frames];
  }

  send(frame: Frame): void {
    this.raw.sendJson(frame);
  }

  /** Send with a fresh ref and resolve with the matching reply. */
  request(frame: Frame): Promise<Frame> {
    const ref = ++this.#ref;
    this.send({ ...frame, ref });
    return this.waitFrame((f) => f.t === "reply" && f.ref === ref);
  }

  join(ch: string, d?: unknown): Promise<Frame> {
    return this.request({ t: "join", ch, d });
  }

  push(ch: string, ev: string, d?: unknown): Promise<Frame> {
    return this.request({ t: "event", ch, ev, d });
  }

  leave(ch: string): Promise<Frame> {
    return this.request({ t: "leave", ch });
  }

  nextEvent(ch: string, ev?: string): Promise<Frame> {
    return this.waitFrame(
      (f) => f.t === "event" && f.ch === ch && (ev == null || f.ev === ev),
    );
  }

  close(): ReturnType<BaseClient["close"]> {
    return this.raw.close();
  }
}

export async function connectChannels(
  url: string,
  init?: { headers?: Record<string, string> },
): Promise<ChannelClient> {
  return new ChannelClient(await baseConnect(url, "fishenv.channels.v1", init));
}
