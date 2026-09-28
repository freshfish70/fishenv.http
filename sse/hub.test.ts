import { assert, assertEquals, assertFalse } from "@std/assert";
import { openConnection, readFrame } from "./_test_utils.ts";
import { SseHub } from "./hub.ts";
import type { SseTransport, SseTransportMessage } from "./types.ts";

// ── targeted send ──────────────────────────────────────────────────────────

Deno.test("SseHub: send reaches only the targeted key", async () => {
  const hub = new SseHub();
  const alice = openConnection();
  const bob = openConnection();

  hub.add("alice", alice.sse);
  hub.add("bob", bob.sse);

  assertEquals(hub.send("alice", { msg: "hi" }, { event: "dm" }), 1);

  assertEquals(
    await readFrame(alice.reader),
    'event: dm\ndata: {"msg":"hi"}\n\n',
  );

  // Bob must see nothing; close his stream so the pending read resolves.
  bob.sse.close();
  assertEquals((await bob.reader.read()).done, true);

  hub.closeAll();
  await alice.reader.cancel();
  await bob.reader.cancel();
});

Deno.test(
  "SseHub: one key fans out to every connection (multi-tab)",
  async () => {
    const hub = new SseHub();
    const tab1 = openConnection();
    const tab2 = openConnection();

    hub.add("user-1", tab1.sse);
    hub.add("user-1", tab2.sse);
    assertEquals(hub.count("user-1"), 2);

    assertEquals(hub.send("user-1", "ping"), 2);
    assertEquals(await readFrame(tab1.reader), "data: ping\n\n");
    assertEquals(await readFrame(tab2.reader), "data: ping\n\n");

    hub.closeAll();
    await tab1.reader.cancel();
    await tab2.reader.cancel();
  },
);

Deno.test("SseHub: send to an unknown key is a no-op", () => {
  const hub = new SseHub();
  assertEquals(hub.send("nobody", "x"), 0);
  assertFalse(hub.has("nobody"));
});

// ── registration lifecycle ─────────────────────────────────────────────────

Deno.test("SseHub: connections deregister themselves on close", async () => {
  const hub = new SseHub();
  const a = openConnection();
  const b = openConnection();

  hub.add("user-1", a.sse);
  hub.add("user-1", b.sse);

  a.sse.close();
  assertEquals(hub.count("user-1"), 1);

  b.sse.close();
  assertEquals(hub.count("user-1"), 0);
  assertEquals(hub.keys(), [], "empty key buckets are pruned");

  await a.reader.cancel();
  await b.reader.cancel();
});

Deno.test("SseHub: manual unregister fn detaches without closing", async () => {
  const hub = new SseHub();
  const conn = openConnection();

  const off = hub.add("user-1", conn.sse);
  off();

  assertEquals(hub.count(), 0);
  assertFalse(conn.sse.closed);

  conn.sse.close();
  await conn.reader.cancel();
});

Deno.test("SseHub: broadcast, sendMany and close(key)", async () => {
  const hub = new SseHub();
  const a = openConnection();
  const b = openConnection();
  const c = openConnection();

  hub.add("a", a.sse);
  hub.add("b", b.sse);
  hub.add("c", c.sse);

  assertEquals(hub.broadcast("all"), 3);
  assertEquals(await readFrame(a.reader), "data: all\n\n");
  assertEquals(await readFrame(b.reader), "data: all\n\n");
  assertEquals(await readFrame(c.reader), "data: all\n\n");

  assertEquals(hub.sendMany(["a", "b"], "some"), 2);
  assertEquals(await readFrame(a.reader), "data: some\n\n");
  assertEquals(await readFrame(b.reader), "data: some\n\n");

  assertEquals(hub.close("a"), 1);
  assert(a.sse.closed);
  assertEquals(hub.count(), 2);

  hub.closeAll();
  await a.reader.cancel();
  await b.reader.cancel();
  await c.reader.cancel();
});

// ── cross-process transport ────────────────────────────────────────────────

Deno.test(
  "SseHub: transport fans out to other nodes without echoing",
  async () => {
    const subscribers: ((m: SseTransportMessage) => void)[] = [];
    const published: SseTransportMessage[] = [];

    const bus = (): SseTransport => ({
      publish(message) {
        published.push(message);
        for (const fn of subscribers) fn(message);
      },
      subscribe(onMessage) {
        subscribers.push(onMessage);
        return () => {
          const i = subscribers.indexOf(onMessage);
          if (i >= 0) subscribers.splice(i, 1);
        };
      },
    });

    const nodeA = new SseHub({ transport: bus() });
    const nodeB = new SseHub({ transport: bus() });

    const onA = openConnection();
    const onB = openConnection();
    nodeA.add("user-1", onA.sse);
    nodeB.add("user-1", onB.sse);

    // Published from A — must reach A's local connection exactly once...
    assertEquals(nodeA.send("user-1", "hello", { event: "dm" }), 1);
    assertEquals(await readFrame(onA.reader), "event: dm\ndata: hello\n\n");

    // ...and B's connection via the bus.
    assertEquals(await readFrame(onB.reader), "event: dm\ndata: hello\n\n");

    // Origin is stamped so the publisher ignores its own echo.
    assertEquals(published.length, 1);
    assertEquals(published[0].key, "user-1");

    // No duplicate delivered to A.
    onA.sse.close();
    assertEquals((await onA.reader.read()).done, true);

    nodeA.closeAll();
    nodeB.closeAll();
    await onA.reader.cancel();
    await onB.reader.cancel();
  },
);
