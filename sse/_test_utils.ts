import { expect } from "bun:test";
import type { DIContainer } from "../core/index.ts";
import type { SseConnection } from "./connection.ts";
import { createSseResponse } from "./response.ts";
import type { SseConnectionOptions } from "./types.ts";

const decoder = new TextDecoder();

/** Open a bare SSE stream without going through the router. */
export function openConnection(
  url = "http://localhost/events",
  options: SseConnectionOptions = {},
): {
  sse: SseConnection;
  res: Response;
  reader: ReadableStreamDefaultReader<Uint8Array>;
} {
  let sse!: SseConnection;
  const res = createSseResponse(new Request(url), options, (c) => {
    sse = c;
  });
  return { sse, res, reader: res.body!.getReader() };
}

/** Each send() enqueues exactly one frame, so one read == one frame. */
export async function readFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const { value, done } = await reader.read();
  expect(done).toBeFalsy();
  return decoder.decode(value);
}

/** Read the next frame that isn't a heartbeat comment. */
export async function readEventFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  let frame = await readFrame(reader);
  while (frame.startsWith(":")) frame = await readFrame(reader);
  return frame;
}

export function containerOf(bindings: Map<unknown, unknown>): DIContainer {
  return {
    get<T>(token: abstract new (...args: never[]) => T): T {
      const instance = bindings.get(token);
      if (instance == null) throw new Error(`No binding for ${token.name}`);
      return instance as T;
    },
  };
}

export async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
