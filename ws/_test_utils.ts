/** Helpers for ws tests that run against a real `serve()`. */

import { afterEach } from "bun:test";
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
