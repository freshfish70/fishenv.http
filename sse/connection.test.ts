import { expect, test } from "bun:test";
import { openConnection, readFrame } from "./_test_utils.ts";
import type { SseConnection } from "./connection.ts";
import { createSseResponse } from "./response.ts";

// ── response shape ─────────────────────────────────────────────────────────

test("createSseResponse: sets streaming headers", async () => {
  const { res, reader } = openConnection();
  expect(res.headers.get("content-type")).toEqual(
    "text/event-stream; charset=utf-8",
  );
  expect(res.headers.get("cache-control")).toEqual(
    "no-cache, no-store, no-transform",
  );
  expect(res.headers.get("x-accel-buffering")).toEqual("no");
  await reader.cancel();
});

test("createSseResponse: emits the retry hint on connect", async () => {
  const { reader } = openConnection("http://localhost/events", {
    retryMs: 5000,
  });
  expect(await readFrame(reader)).toEqual("retry: 5000\n\n");
  await reader.cancel();
});

// ── lifecycle ──────────────────────────────────────────────────────────────

test("SseConnection: lastEventId from header, then query fallback", async () => {
  const withHeader = createSseResponse(
    new Request("http://localhost/events", {
      headers: { "last-event-id": "abc" },
    }),
    {},
    (sse) => {
      expect(sse.lastEventId).toEqual("abc");
    },
  );
  await withHeader.body!.cancel();

  const withQuery = createSseResponse(
    new Request("http://localhost/events?lastEventId=xyz"),
    {},
    (sse) => {
      expect(sse.lastEventId).toEqual("xyz");
    },
  );
  await withQuery.body!.cancel();
});

test("SseConnection: close is idempotent and runs callbacks once", async () => {
  const { sse, reader } = openConnection();
  let calls = 0;
  sse.onClose(() => calls++);

  sse.close();
  sse.close();

  expect(calls).toEqual(1);
  expect(sse.closed).toBeTruthy();
  expect(sse.send("after close")).toBeFalsy();
  expect((await reader.read()).done).toEqual(true);
});

test("SseConnection: onClose after close runs immediately", async () => {
  const { sse, reader } = openConnection();
  sse.close();
  let ran = false;
  sse.onClose(() => (ran = true));
  expect(ran).toBeTruthy();
  await reader.cancel();
});

test("SseConnection: client cancel closes the connection and runs cleanup", async () => {
  let cleanedUp = false;
  let sse!: SseConnection;
  const res = createSseResponse(
    new Request("http://localhost/events"),
    {},
    (c) => {
      sse = c;
      return () => {
        cleanedUp = true;
      };
    },
  );

  // Let the async open callback register its cleanup fn.
  await Promise.resolve();
  await res.body!.cancel();

  expect(sse.closed).toBeTruthy();
  expect(cleanedUp).toBeTruthy();
});

// ── backpressure ───────────────────────────────────────────────────────────

test("backpressure: close policy drops a stalled client", async () => {
  const { sse, reader } = openConnection("http://localhost/events", {
    highWaterMark: 64,
    onOverflow: "close",
  });

  expect(sse.send("x".repeat(200))).toBeTruthy();
  expect(sse.send("overflow")).toBeFalsy();
  expect(sse.closed).toBeTruthy();

  await reader.cancel();
});

test("backpressure: drop policy keeps the connection open", async () => {
  const { sse, reader } = openConnection("http://localhost/events", {
    highWaterMark: 64,
    onOverflow: "drop",
  });

  expect(sse.send("x".repeat(200))).toBeTruthy();
  expect(sse.send("dropped")).toBeFalsy();
  expect(sse.closed).toBeFalsy();

  sse.close();
  await reader.cancel();
});
