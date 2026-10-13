import { expect, test } from "bun:test";
import { openConnection, readFrame } from "./_test_utils.ts";
import { SseHub } from "./hub.ts";
import type { SseTransport, SseTransportMessage } from "./types.ts";

// ── targeted send ──────────────────────────────────────────────────────────

test("SseHub: send reaches only the targeted key", async () => {
  const hub = new SseHub();
  const alice = openConnection();
  const bob = openConnection();

  hub.add("alice", alice.sse);
  hub.add("bob", bob.sse);

  expect(hub.send("alice", { msg: "hi" }, { event: "dm" })).toEqual(1);

  expect(await readFrame(alice.reader)).toEqual(
    'event: dm\ndata: {"msg":"hi"}\n\n',
  );

  // Bob must see nothing; close his stream so the pending read resolves.
  bob.sse.close();
  expect((await bob.reader.read()).done).toEqual(true);

  hub.closeAll();
  await alice.reader.cancel();
  await bob.reader.cancel();
});

test("SseHub: one key fans out to every connection (multi-tab)", async () => {
  const hub = new SseHub();
  const tab1 = openConnection();
  const tab2 = openConnection();

  hub.add("user-1", tab1.sse);
  hub.add("user-1", tab2.sse);
  expect(hub.count("user-1")).toEqual(2);

  expect(hub.send("user-1", "ping")).toEqual(2);
  expect(await readFrame(tab1.reader)).toEqual("data: ping\n\n");
  expect(await readFrame(tab2.reader)).toEqual("data: ping\n\n");

  hub.closeAll();
  await tab1.reader.cancel();
  await tab2.reader.cancel();
});

test("SseHub: send to an unknown key is a no-op", () => {
  const hub = new SseHub();
  expect(hub.send("nobody", "x")).toEqual(0);
  expect(hub.has("nobody")).toBeFalsy();
});

// ── registration lifecycle ─────────────────────────────────────────────────

test("SseHub: connections deregister themselves on close", async () => {
  const hub = new SseHub();
  const a = openConnection();
  const b = openConnection();

  hub.add("user-1", a.sse);
  hub.add("user-1", b.sse);

  a.sse.close();
  expect(hub.count("user-1")).toEqual(1);

  b.sse.close();
  expect(hub.count("user-1")).toEqual(0);
  expect(hub.keys()).toEqual([]);

  await a.reader.cancel();
  await b.reader.cancel();
});

test("SseHub: manual unregister fn detaches without closing", async () => {
  const hub = new SseHub();
  const conn = openConnection();

  const off = hub.add("user-1", conn.sse);
  off();

  expect(hub.count()).toEqual(0);
  expect(conn.sse.closed).toBeFalsy();

  conn.sse.close();
  await conn.reader.cancel();
});

test("SseHub: broadcast, sendMany and close(key)", async () => {
  const hub = new SseHub();
  const a = openConnection();
  const b = openConnection();
  const c = openConnection();

  hub.add("a", a.sse);
  hub.add("b", b.sse);
  hub.add("c", c.sse);

  expect(hub.broadcast("all")).toEqual(3);
  expect(await readFrame(a.reader)).toEqual("data: all\n\n");
  expect(await readFrame(b.reader)).toEqual("data: all\n\n");
  expect(await readFrame(c.reader)).toEqual("data: all\n\n");

  expect(hub.sendMany(["a", "b"], "some")).toEqual(2);
  expect(await readFrame(a.reader)).toEqual("data: some\n\n");
  expect(await readFrame(b.reader)).toEqual("data: some\n\n");

  expect(hub.close("a")).toEqual(1);
  expect(a.sse.closed).toBeTruthy();
  expect(hub.count()).toEqual(2);

  hub.closeAll();
  await a.reader.cancel();
  await b.reader.cancel();
  await c.reader.cancel();
});

// ── cross-process transport ────────────────────────────────────────────────

test("SseHub: transport fans out to other nodes without echoing", async () => {
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
  expect(nodeA.send("user-1", "hello", { event: "dm" })).toEqual(1);
  expect(await readFrame(onA.reader)).toEqual("event: dm\ndata: hello\n\n");

  // ...and B's connection via the bus.
  expect(await readFrame(onB.reader)).toEqual("event: dm\ndata: hello\n\n");

  // Origin is stamped so the publisher ignores its own echo.
  expect(published.length).toEqual(1);
  expect(published[0].key).toEqual("user-1");

  // No duplicate delivered to A.
  onA.sse.close();
  expect((await onA.reader.read()).done).toEqual(true);

  nodeA.closeAll();
  nodeB.closeAll();
  await onA.reader.cancel();
  await onB.reader.cancel();
});
