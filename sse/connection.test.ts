import { assert, assertEquals, assertFalse } from "@std/assert";
import { openConnection, readFrame } from "./_test_utils.ts";
import type { SseConnection } from "./connection.ts";
import { createSseResponse } from "./response.ts";

// ── response shape ─────────────────────────────────────────────────────────

Deno.test("createSseResponse: sets streaming headers", async () => {
  const { res, reader } = openConnection();
  assertEquals(
    res.headers.get("content-type"),
    "text/event-stream; charset=utf-8",
  );
  assertEquals(
    res.headers.get("cache-control"),
    "no-cache, no-store, no-transform",
  );
  assertEquals(res.headers.get("x-accel-buffering"), "no");
  await reader.cancel();
});

Deno.test("createSseResponse: emits the retry hint on connect", async () => {
  const { reader } = openConnection("http://localhost/events", {
    retryMs: 5000,
  });
  assertEquals(await readFrame(reader), "retry: 5000\n\n");
  await reader.cancel();
});

// ── lifecycle ──────────────────────────────────────────────────────────────

Deno.test(
  "SseConnection: lastEventId from header, then query fallback",
  async () => {
    const withHeader = createSseResponse(
      new Request("http://localhost/events", {
        headers: { "last-event-id": "abc" },
      }),
      {},
      (sse) => {
        assertEquals(sse.lastEventId, "abc");
      },
    );
    await withHeader.body!.cancel();

    const withQuery = createSseResponse(
      new Request("http://localhost/events?lastEventId=xyz"),
      {},
      (sse) => {
        assertEquals(sse.lastEventId, "xyz");
      },
    );
    await withQuery.body!.cancel();
  },
);

Deno.test(
  "SseConnection: close is idempotent and runs callbacks once",
  async () => {
    const { sse, reader } = openConnection();
    let calls = 0;
    sse.onClose(() => calls++);

    sse.close();
    sse.close();

    assertEquals(calls, 1);
    assert(sse.closed);
    assertFalse(sse.send("after close"));
    assertEquals((await reader.read()).done, true);
  },
);

Deno.test("SseConnection: onClose after close runs immediately", async () => {
  const { sse, reader } = openConnection();
  sse.close();
  let ran = false;
  sse.onClose(() => (ran = true));
  assert(ran);
  await reader.cancel();
});

Deno.test(
  "SseConnection: client cancel closes the connection and runs cleanup",
  async () => {
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

    assert(sse.closed, "connection should be closed after client cancel");
    assert(cleanedUp, "cleanup fn should run on client disconnect");
  },
);

// ── backpressure ───────────────────────────────────────────────────────────

Deno.test("backpressure: close policy drops a stalled client", async () => {
  const { sse, reader } = openConnection("http://localhost/events", {
    highWaterMark: 64,
    onOverflow: "close",
  });

  assert(sse.send("x".repeat(200)), "first write fits under the watermark");
  assertFalse(sse.send("overflow"), "second write exceeds the watermark");
  assert(sse.closed, "connection closed instead of buffering unboundedly");

  await reader.cancel();
});

Deno.test("backpressure: drop policy keeps the connection open", async () => {
  const { sse, reader } = openConnection("http://localhost/events", {
    highWaterMark: 64,
    onOverflow: "drop",
  });

  assert(sse.send("x".repeat(200)));
  assertFalse(sse.send("dropped"));
  assertFalse(sse.closed, "connection stays open under the drop policy");

  sse.close();
  await reader.cancel();
});
