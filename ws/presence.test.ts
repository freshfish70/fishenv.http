import { describe, expect, it } from "bun:test";
import type { Transport } from "../core/index.ts";
import type { WsConnection } from "./connection.ts";
import { WsHub, type WsTransportMessage } from "./hub.ts";
import type { PresenceDiff, PresenceOptions } from "./presence.ts";

// ── Fakes ──────────────────────────────────────────────────────────────

/** Minimal WsConnection stand-in: presence only needs id/closed/onClose. */
function fakeSocket(id: string) {
  const closers: (() => void)[] = [];
  const socket = {
    id,
    closed: false,
    onClose(fn: () => void) {
      closers.push(fn);
    },
    close() {
      socket.closed = true;
      for (const fn of closers.splice(0)) fn();
    },
  };
  return socket as unknown as WsConnection & { close(): void };
}

/** Manual clock + timers shared by every hub in a test. */
function fakeTime() {
  let now = 0;
  const intervals: (() => void)[] = [];
  const options: PresenceOptions = {
    now: () => now,
    setTimer: () => 1, // batches are flushed explicitly via flush()
    clearTimer: () => {},
    setInterval: (fn) => {
      intervals.push(fn);
      return intervals.length;
    },
    clearInterval: (h) => {
      intervals[(h as number) - 1] = () => {};
    },
  };
  return {
    options,
    advance(ms: number) {
      now += ms;
    },
    /** Run every heartbeat/sweep interval once. */
    tick() {
      for (const fn of [...intervals]) fn();
    },
  };
}

/**
 * In-memory transport where individual deliveries can be dropped, to
 * simulate a lossy broker or a partition.
 */
function lossyTransport() {
  const subscribers = new Map<number, (m: WsTransportMessage) => void>();
  let nextId = 0;
  let drop: (m: WsTransportMessage, subscriber: number) => boolean = () =>
    false;
  const transport: Transport<WsTransportMessage> & {
    dropWhen(fn: typeof drop): void;
  } = {
    publish(message) {
      const copy = JSON.parse(JSON.stringify(message)) as WsTransportMessage;
      for (const [id, fn] of [...subscribers]) if (!drop(copy, id)) fn(copy);
    },
    subscribe(fn) {
      const id = nextId++;
      subscribers.set(id, fn);
      return () => subscribers.delete(id);
    },
    dropWhen(fn) {
      drop = fn;
    },
  };
  return transport;
}

function collect(hub: WsHub, topic: string) {
  const diffs: PresenceDiff[] = [];
  hub.presence(topic).onDiff((d) => diffs.push(d));
  return diffs;
}

// ── Single node ────────────────────────────────────────────────────────

describe("presence on one node", () => {
  it("groups entries by key (multi-tab) and untracks on close", () => {
    const hub = new WsHub({ name: "p" });
    const online = hub.presence<{ status: string }>("online");
    const tab1 = fakeSocket("c1");
    const tab2 = fakeSocket("c2");
    const bob = fakeSocket("c3");

    online.track(tab1, "alice", { status: "online" });
    online.track(tab2, "alice", { status: "away" });
    online.track(bob, "bob", { status: "online" });

    expect(online.list()).toEqual({
      alice: [
        { ref: "c1", meta: { status: "online" } },
        { ref: "c2", meta: { status: "away" } },
      ],
      bob: [{ ref: "c3", meta: { status: "online" } }],
    });
    expect(online.count()).toEqual(2);

    tab1.close(); // one tab closing is not a leave of alice
    expect(online.has("alice")).toEqual(true);
    tab2.close();
    expect(online.has("alice")).toEqual(false);
    expect(online.keys()).toEqual(["bob"]);
  });

  it("update replaces meta; untrack removes; topics are independent", () => {
    const hub = new WsHub({ name: "p" });
    const s = fakeSocket("c1");
    hub.presence("a").track(s, "alice", 1);
    hub.presence("b").track(s, "alice", 2);
    expect(hub.presence("a").update(s, 10)).toEqual(true);
    expect(hub.presence("a").list()).toEqual({
      alice: [{ ref: "c1", meta: 10 }],
    });
    hub.presence("a").untrack(s);
    expect(hub.presence("a").list()).toEqual({});
    expect(hub.presence("b").list()).toEqual({
      alice: [{ ref: "c1", meta: 2 }],
    });
    expect(hub.presence("c").update(s, 1)).toEqual(false);
  });

  it("closed sockets are never tracked", () => {
    const hub = new WsHub({ name: "p" });
    const s = fakeSocket("c1");
    s.close();
    hub.presence("t").track(s, "alice", {});
    expect(hub.presence("t").list()).toEqual({});
  });

  it("caps entries per topic", () => {
    const hub = new WsHub({ name: "p", presence: { maxEntriesPerTopic: 2 } });
    const t = hub.presence("t");
    t.track(fakeSocket("1"), "a", {});
    t.track(fakeSocket("2"), "b", {});
    expect(() => t.track(fakeSocket("3"), "c", {})).toThrow(/full/);
  });
});

describe("diff batching", () => {
  it("coalesces changes within a window into one diff", () => {
    const time = fakeTime();
    const hub = new WsHub({ name: "p", presence: time.options });
    const diffs = collect(hub, "t");
    hub.presence("t").track(fakeSocket("c1"), "alice", 1);
    hub.presence("t").track(fakeSocket("c2"), "bob", 2);
    hub._presenceRegistry().flush();

    expect(diffs).toEqual([
      {
        joins: {
          alice: [{ ref: "c1", meta: 1 }],
          bob: [{ ref: "c2", meta: 2 }],
        },
        leaves: {},
      },
    ]);
  });

  it("a join and leave within one window cancel out", () => {
    const time = fakeTime();
    const hub = new WsHub({ name: "p", presence: time.options });
    const diffs = collect(hub, "t");
    const s = fakeSocket("c1");
    hub.presence("t").track(s, "alice", 1);
    hub.presence("t").update(s, 2);
    s.close();
    hub._presenceRegistry().flush();
    expect(diffs).toEqual([]);
  });

  it("updating a seen entry yields leave(old) + join(new)", () => {
    const time = fakeTime();
    const hub = new WsHub({ name: "p", presence: time.options });
    const diffs = collect(hub, "t");
    const s = fakeSocket("c1");
    hub.presence("t").track(s, "alice", "online");
    hub._presenceRegistry().flush();
    hub.presence("t").update(s, "away");
    hub.presence("t").update(s, "busy");
    hub._presenceRegistry().flush();

    expect(diffs[1]).toEqual({
      joins: { alice: [{ ref: "c1", meta: "busy" }] },
      leaves: { alice: [{ ref: "c1", meta: "online" }] },
    });
  });

  it("leaving after an in-window update still reports the originally seen entry", () => {
    const time = fakeTime();
    const hub = new WsHub({ name: "p", presence: time.options });
    const diffs = collect(hub, "t");
    const s = fakeSocket("c1");
    hub.presence("t").track(s, "alice", "online");
    hub._presenceRegistry().flush();
    hub.presence("t").update(s, "away");
    s.close();
    hub._presenceRegistry().flush();
    expect(diffs[1]).toEqual({
      joins: {},
      leaves: { alice: [{ ref: "c1", meta: "online" }] },
    });
  });

  it("flushes automatically after batchMs with real timers", async () => {
    const hub = new WsHub({ name: "p", presence: { batchMs: 10 } });
    const diffs = collect(hub, "t");
    hub.presence("t").track(fakeSocket("c1"), "alice", 1);
    expect(diffs).toEqual([]);
    await Bun.sleep(30);
    expect(diffs).toHaveLength(1);
  });
});

// ── Replication ────────────────────────────────────────────────────────

describe("presence across nodes", () => {
  function cluster(n: number) {
    const time = fakeTime();
    const transport = lossyTransport();
    const hubs = Array.from(
      { length: n },
      () => new WsHub({ name: "chat", transport, presence: time.options }),
    );
    // Create registries (subscribes + initial sync_request) in order.
    for (const hub of hubs) hub._presenceRegistry();
    return { time, transport, hubs };
  }
  const flushAll = (hubs: WsHub[]) => {
    for (const h of hubs) h._presenceRegistry().flush();
  };

  it("local tracks become visible on every node, with diffs", () => {
    const { hubs } = cluster(2);
    const [a, b] = hubs as [WsHub, WsHub];
    const diffsB = collect(b, "room");

    a.presence("room").track(fakeSocket("a1"), "alice", { s: 1 });
    flushAll(hubs);
    expect(b.presence("room").list()).toEqual({
      alice: [{ ref: "a1", meta: { s: 1 } }],
    });
    expect(diffsB).toEqual([
      { joins: { alice: [{ ref: "a1", meta: { s: 1 } }] }, leaves: {} },
    ]);
  });

  it("merges entries of the same key from different nodes", () => {
    const { hubs } = cluster(2);
    const [a, b] = hubs as [WsHub, WsHub];
    a.presence("room").track(fakeSocket("a1"), "alice", "desktop");
    b.presence("room").track(fakeSocket("b1"), "alice", "phone");
    for (const hub of hubs) {
      expect(
        hub
          .presence("room")
          .list()
          .alice?.map((e) => e.meta)
          .sort(),
      ).toEqual(["desktop", "phone"]);
    }
  });

  it("untracks propagate", () => {
    const { hubs } = cluster(2);
    const [a, b] = hubs as [WsHub, WsHub];
    const s = fakeSocket("a1");
    a.presence("room").track(s, "alice", {});
    s.close();
    expect(b.presence("room").list()).toEqual({});
  });

  it("a late-joining node receives the full state via sync", () => {
    const time = fakeTime();
    const transport = lossyTransport();
    const a = new WsHub({ name: "chat", transport, presence: time.options });
    a.presence("room").track(fakeSocket("a1"), "alice", 1);
    a.presence("lobby").track(fakeSocket("a2"), "bob", 2);

    const late = new WsHub({ name: "chat", transport, presence: time.options });
    const diffs: [string, PresenceDiff][] = [];
    const registry = late._presenceRegistry(); // sends sync_request "*"
    registry.onDiff((topic, diff) => diffs.push([topic, diff]));
    registry.flush();

    expect(late.presence("room").list()).toEqual({
      alice: [{ ref: "a1", meta: 1 }],
    });
    expect(late.presence("lobby").list()).toEqual({
      bob: [{ ref: "a2", meta: 2 }],
    });
    expect(diffs.map(([t]) => t).sort()).toEqual(["lobby", "room"]);
  });

  it("a dropped message is detected by the clock gap and healed by sync", () => {
    const { hubs, transport } = cluster(2);
    const [a, b] = hubs as [WsHub, WsHub];

    // Drop exactly one diff from A on its way to B (subscriber #1).
    let dropped = false;
    transport.dropWhen((m, subscriber) => {
      if (dropped || subscriber !== 1 || m.kind !== "presence") return false;
      const body = m.body as { op: string; node: string };
      if (body.op === "diff" && body.node === a.nodeId) {
        dropped = true;
        return true;
      }
      return false;
    });
    a.presence("room").track(fakeSocket("a1"), "alice", 1); // lost for B
    transport.dropWhen(() => false);
    expect(b.presence("room").list()).toEqual({});

    a.presence("room").track(fakeSocket("a2"), "carol", 2); // gap → B requests sync
    expect(b.presence("room").list()).toEqual({
      alice: [{ ref: "a1", meta: 1 }],
      carol: [{ ref: "a2", meta: 2 }],
    });
  });

  it("duplicate deliveries are ignored", () => {
    const time = fakeTime();
    const subscribers: ((m: WsTransportMessage) => void)[] = [];
    const duplicating: Transport<WsTransportMessage> = {
      publish(m) {
        for (const fn of [...subscribers]) {
          fn(structuredClone(m));
          fn(structuredClone(m));
        }
      },
      subscribe(fn) {
        subscribers.push(fn);
        return () => {};
      },
    };
    const a = new WsHub({
      name: "chat",
      transport: duplicating,
      presence: time.options,
    });
    const b = new WsHub({
      name: "chat",
      transport: duplicating,
      presence: time.options,
    });
    a._presenceRegistry();
    const diffs = collect(b, "room");
    a.presence("room").track(fakeSocket("a1"), "alice", 1);
    b._presenceRegistry().flush();
    expect(diffs).toHaveLength(1);
    expect(b.presence("room").list()).toEqual({
      alice: [{ ref: "a1", meta: 1 }],
    });
  });

  it("a node that stops heart-beating is dropped with synthesized leaves", () => {
    const { hubs, time } = cluster(2);
    const [a, b] = hubs as [WsHub, WsHub];
    b.presence("room").track(fakeSocket("b1"), "bob", 1);
    expect(a.presence("room").has("bob")).toEqual(true);
    a._presenceRegistry().flush(); // listeners have seen bob join
    const diffsA = collect(a, "room");

    // B crashes: no more heartbeats from it.
    b.closeAll();
    time.advance(10_000);
    time.tick(); // A heartbeats + sweeps; B is within timeout still
    expect(a.presence("room").has("bob")).toEqual(true);

    time.advance(10_000); // now > 15 s since B was last seen
    time.tick();
    a._presenceRegistry().flush();
    expect(a.presence("room").has("bob")).toEqual(false);
    expect(diffsA.at(-1)).toEqual({
      joins: {},
      leaves: { bob: [{ ref: "b1", meta: 1 }] },
    });
  });

  it("heartbeats keep quiet nodes alive", () => {
    const { hubs, time } = cluster(2);
    const [a, b] = hubs as [WsHub, WsHub];
    b.presence("room").track(fakeSocket("b1"), "bob", 1);
    for (let i = 0; i < 10; i++) {
      time.advance(5_000);
      time.tick(); // both nodes heartbeat every tick
    }
    expect(a.presence("room").has("bob")).toEqual(true);
  });

  it("an unknown node with a non-initial clock triggers a sync", () => {
    const { hubs, transport } = cluster(2);
    const [a, b] = hubs as [WsHub, WsHub];
    // B misses everything A says…
    transport.dropWhen((m) => m.origin === a.nodeId);
    a.presence("room").track(fakeSocket("a1"), "alice", 1);
    a.presence("room").track(fakeSocket("a2"), "bob", 2);
    transport.dropWhen(() => false);
    expect(b.presence("room").list()).toEqual({});
    // …until A's next message reveals the gap.
    a.presence("room").track(fakeSocket("a3"), "carol", 3);
    expect(b.presence("room").keys().sort()).toEqual(["alice", "bob", "carol"]);
  });

  it("three nodes converge", () => {
    const { hubs } = cluster(3);
    hubs.forEach((hub, i) => {
      hub.presence("room").track(fakeSocket(`n${i}`), `user${i}`, i);
    });
    for (const hub of hubs) {
      expect(hub.presence("room").keys().sort()).toEqual([
        "user0",
        "user1",
        "user2",
      ]);
    }
  });
});
