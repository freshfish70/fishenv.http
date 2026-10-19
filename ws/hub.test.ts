import { describe, expect, it } from "bun:test";
import { createMemoryTransport, type DIContainer, r } from "../core/index.ts";
import {
  connect,
  startServer,
  type TestClient,
  useServers,
  waitFor,
} from "./_test_utils.ts";
import type { WsConnection } from "./connection.ts";
import { WsHub, type WsTransportMessage } from "./hub.ts";
import { withWs } from "./router.ts";

useServers();

class ChatSockets extends WsHub {}

function containerWith(hub: WsHub): DIContainer {
  return {
    get: <T>(token: unknown) => {
      if (token === ChatSockets || token === WsHub) return hub as T;
      throw new Error("unknown token");
    },
  } as DIContainer;
}

/**
 * A server whose `/ws` route registers each socket in `hub` under the
 * `?user=` query param, and records the server-side WsConnection.
 */
function hubServer(hub: WsHub) {
  const sockets = new Map<string, WsConnection>();
  const app = withWs(
    r().use(({ req }) => ({
      user: new URL(req.url).searchParams.get("user") ?? "anon",
      tab: new URL(req.url).searchParams.get("tab") ?? "0",
    })),
  );
  app.ws("/ws").handle(({ socket, ctx }) => {
    hub.add(ctx.user, socket);
    sockets.set(`${ctx.user}:${ctx.tab}`, socket);
    socket.send("ready");
  });
  const server = startServer(app, { container: containerWith(hub) });

  const open = async (user: string, tab = "0"): Promise<TestClient> => {
    const client = await connect(server.url(`/ws?user=${user}&tab=${tab}`));
    expect(await client.nextText()).toEqual("ready");
    return client;
  };
  return { server, sockets, open };
}

/** Wait a beat and assert nothing else arrived. */
async function expectSilence(...clients: TestClient[]): Promise<void> {
  await Bun.sleep(30);
  for (const c of clients) expect(c.pending).toEqual(0);
}

// ── keys ───────────────────────────────────────────────────────────────

describe("WsHub keys", () => {
  it("send() reaches every tab of a key and nobody else", async () => {
    const hub = new ChatSockets();
    const { open } = hubServer(hub);
    const tab1 = await open("alice", "1");
    const tab2 = await open("alice", "2");
    const bob = await open("bob");

    expect(hub.send("alice", { msg: "hi" })).toEqual(2);
    expect(await tab1.nextJson()).toEqual({ msg: "hi" });
    expect(await tab2.nextJson()).toEqual({ msg: "hi" });
    await expectSilence(bob);
  });

  it("strings and binary go out as-is; objects as JSON", async () => {
    const hub = new ChatSockets();
    const { open } = hubServer(hub);
    const alice = await open("alice");

    hub.send("alice", "plain");
    hub.send("alice", new Uint8Array([1, 2]));
    hub.send("alice", [1, 2]);
    expect(await alice.nextText()).toEqual("plain");
    expect([...new Uint8Array((await alice.next()) as ArrayBuffer)]).toEqual([
      1, 2,
    ]);
    expect(await alice.nextText()).toEqual("[1,2]");
  });

  it("introspection: has, count, keys, connections", async () => {
    const hub = new ChatSockets();
    const { open } = hubServer(hub);
    await open("alice", "1");
    await open("alice", "2");
    await open("bob");

    expect(hub.has("alice")).toEqual(true);
    expect(hub.has("carol")).toEqual(false);
    expect(hub.count("alice")).toEqual(2);
    expect(hub.count()).toEqual(3);
    expect(hub.keys().sort()).toEqual(["alice", "bob"]);
    expect(hub.connections("alice")).toHaveLength(2);
  });

  it("sockets deregister themselves on close", async () => {
    const hub = new ChatSockets();
    const { open } = hubServer(hub);
    const alice = await open("alice");
    await alice.close();
    await waitFor(() => !hub.has("alice"), "deregistration");
    expect(hub.keys()).toEqual([]);
    expect(hub.send("alice", "x")).toEqual(0);
  });

  it("the returned fn unregisters; re-adding moves the socket to a new key", async () => {
    const hub = new ChatSockets();
    const { open, sockets } = hubServer(hub);
    await open("alice");
    const socket = sockets.get("alice:0")!;

    hub.add("renamed", socket);
    expect(hub.has("alice")).toEqual(false);
    expect(hub.keyOf(socket)).toEqual("renamed");

    const off = hub.add("again", socket);
    off();
    expect(hub.count()).toEqual(0);
  });

  it("broadcast() reaches every keyed socket", async () => {
    const hub = new ChatSockets();
    const { open } = hubServer(hub);
    const a = await open("a");
    const b = await open("b");
    expect(hub.broadcast("all")).toEqual(2);
    expect(await a.nextText()).toEqual("all");
    expect(await b.nextText()).toEqual("all");
  });

  it("sendMany() targets several keys", async () => {
    const hub = new ChatSockets();
    const { open } = hubServer(hub);
    const a = await open("a");
    const b = await open("b");
    const c = await open("c");
    expect(hub.sendMany(["a", "c"], "x")).toEqual(2);
    expect(await a.nextText()).toEqual("x");
    expect(await c.nextText()).toEqual("x");
    await expectSilence(b);
  });

  it("close(key) closes every tab of that key with the given code", async () => {
    const hub = new ChatSockets();
    const { open } = hubServer(hub);
    const tab1 = await open("alice", "1");
    const tab2 = await open("alice", "2");
    const bob = await open("bob");

    expect(hub.close("alice", 4401, "logged out")).toEqual(2);
    expect(await tab1.closed).toEqual({ code: 4401, reason: "logged out" });
    expect(await tab2.closed).toEqual({ code: 4401, reason: "logged out" });
    expect(bob.ws.readyState).toEqual(WebSocket.OPEN);
  });

  it("closeAll() closes everything with 1001", async () => {
    const hub = new ChatSockets();
    const { open } = hubServer(hub);
    const a = await open("a");
    hub.closeAll();
    expect((await a.closed).code).toEqual(1001);
  });

  it(".subscribe(Token, keyFn) registers via the DI container", async () => {
    const hub = new ChatSockets();
    const app = withWs(r().use(() => ({ user: "u1" })));
    app.ws("/live").subscribe(ChatSockets, ({ ctx }) => ctx.user);
    const { url } = startServer(app, { container: containerWith(hub) });

    const client = await connect(url("/live"));
    await waitFor(() => hub.has("u1"), "registration");
    hub.send("u1", "pushed");
    expect(await client.nextText()).toEqual("pushed");
  });
});

// ── rooms ──────────────────────────────────────────────────────────────

describe("WsHub rooms", () => {
  it("to(room).send() reaches members only", async () => {
    const hub = new ChatSockets();
    const { open, sockets } = hubServer(hub);
    const a = await open("a");
    const b = await open("b");
    const c = await open("c");
    hub.join(sockets.get("a:0")!, "team");
    hub.join(sockets.get("b:0")!, "team");

    expect(hub.to("team").send({ t: 1 })).toEqual(2);
    expect(await a.nextJson()).toEqual({ t: 1 });
    expect(await b.nextJson()).toEqual({ t: 1 });
    await expectSilence(c);
    expect(hub.to("team").count()).toEqual(2);
  });

  it("join is idempotent (no duplicate delivery)", async () => {
    const hub = new ChatSockets();
    const { open, sockets } = hubServer(hub);
    const a = await open("a");
    hub.join(sockets.get("a:0")!, "team");
    hub.join(sockets.get("a:0")!, "team");
    hub.to("team").send("once");
    expect(await a.nextText()).toEqual("once");
    await expectSilence(a);
  });

  it("except(socket) and except(key) exclude members", async () => {
    const hub = new ChatSockets();
    const { open, sockets } = hubServer(hub);
    const a1 = await open("a", "1");
    const a2 = await open("a", "2");
    const b = await open("b");
    const c = await open("c");
    for (const id of ["a:1", "a:2", "b:0", "c:0"]) {
      hub.join(sockets.get(id)!, "room");
    }

    expect(hub.to("room").except(sockets.get("a:1")!).send("not-a1")).toEqual(
      3,
    );
    expect(await a2.nextText()).toEqual("not-a1");
    expect(await b.nextText()).toEqual("not-a1");
    expect(await c.nextText()).toEqual("not-a1");
    await expectSilence(a1);

    expect(
      hub.to("room").except("a", sockets.get("b:0")!).send("c-only"),
    ).toEqual(1);
    expect(await c.nextText()).toEqual("c-only");
    await expectSilence(a1, a2, b);
  });

  it("leave() stops delivery, including the native topic subscription", async () => {
    const hub = new ChatSockets();
    const { open, sockets } = hubServer(hub);
    const a = await open("a");
    const socket = sockets.get("a:0")!;
    hub.join(socket, "room");
    hub.leave(socket, "room");
    expect(socket.raw.isSubscribed("fx:ChatSockets:r:room")).toEqual(false);
    expect(hub.to("room").send("x")).toEqual(0);
    await expectSilence(a);
    expect(hub.roomNames()).toEqual([]);
  });

  it("closed sockets leave all their rooms", async () => {
    const hub = new ChatSockets();
    const { open, sockets } = hubServer(hub);
    const a = await open("a");
    hub.join(sockets.get("a:0")!, "r1");
    hub.join(sockets.get("a:0")!, "r2");
    expect(hub.rooms(sockets.get("a:0")!).sort()).toEqual(["r1", "r2"]);
    await a.close();
    await waitFor(() => hub.roomNames().length === 0, "room cleanup");
  });

  it("works for sockets that were never keyed", async () => {
    const hub = new ChatSockets();
    const app = withWs(r());
    app.ws("/ws").handle(({ socket }) => {
      hub.join(socket, "anon");
      socket.send("ready");
    });
    const { url } = startServer(app);
    const client = await connect(url("/ws"));
    await client.nextText();
    hub.to("anon").send("hello");
    expect(await client.nextText()).toEqual("hello");
    await client.close();
    await waitFor(() => hub.roomNames().length === 0, "cleanup");
  });

  it("room topics are namespaced per hub", async () => {
    class OtherSockets extends WsHub {}
    const chat = new ChatSockets();
    const other = new OtherSockets();
    const { open, sockets } = hubServer(chat);
    const a = await open("a");
    const b = await open("b");
    chat.join(sockets.get("a:0")!, "same-name");
    other.join(sockets.get("b:0")!, "same-name");

    chat.to("same-name").send("chat");
    expect(await a.nextText()).toEqual("chat");
    await expectSilence(b);
  });

  it("fans out across several servers in one process", async () => {
    const hub = new ChatSockets();
    const one = hubServer(hub);
    const two = hubServer(hub);
    const a = await one.open("a");
    const b = await two.open("b");
    hub.join(one.sockets.get("a:0")!, "room");
    hub.join(two.sockets.get("b:0")!, "room");

    expect(hub.to("room").send("both")).toEqual(2);
    expect(await a.nextText()).toEqual("both");
    expect(await b.nextText()).toEqual("both");
  });
});

// ── transport (multi-node) ─────────────────────────────────────────────

describe("WsHub transport", () => {
  /** Two "nodes": separate hubs + servers sharing one transport. */
  function cluster() {
    const transport = createMemoryTransport<WsTransportMessage>();
    const hubA = new ChatSockets({ transport });
    const hubB = new ChatSockets({ transport });
    return { transport, a: hubServer(hubA), b: hubServer(hubB), hubA, hubB };
  }

  it("send(key) reaches sockets on other nodes exactly once", async () => {
    const { a, b, hubA } = cluster();
    const local = await a.open("alice", "1");
    const remote = await b.open("alice", "2");

    expect(hubA.send("alice", "hi")).toEqual(1); // local count only
    expect(await local.nextText()).toEqual("hi");
    expect(await remote.nextText()).toEqual("hi");
    await expectSilence(local, remote);
  });

  it("broadcast reaches every node", async () => {
    const { a, b, hubB } = cluster();
    const x = await a.open("x");
    const y = await b.open("y");
    hubB.broadcast("all");
    expect(await x.nextText()).toEqual("all");
    expect(await y.nextText()).toEqual("all");
  });

  it("room sends and exclusions cross nodes", async () => {
    const { a, b, hubA, hubB } = cluster();
    const sender = await a.open("alice");
    const peer = await b.open("bob");
    const carol = await b.open("carol");
    hubA.join(a.sockets.get("alice:0")!, "room");
    hubB.join(b.sockets.get("bob:0")!, "room");
    hubB.join(b.sockets.get("carol:0")!, "room");

    hubA.to("room").except(a.sockets.get("alice:0")!, "carol").send("msg");
    expect(await peer.nextText()).toEqual("msg");
    await expectSilence(sender, carol);
  });

  it("close(key) closes sockets on every node", async () => {
    const { a, b, hubA } = cluster();
    const tab1 = await a.open("alice", "1");
    const tab2 = await b.open("alice", "2");
    hubA.close("alice", 4401, "revoked");
    expect((await tab1.closed).code).toEqual(4401);
    expect((await tab2.closed).code).toEqual(4401);
  });

  it("binary payloads survive the transport", async () => {
    const { a, b, hubA } = cluster();
    await a.open("other");
    const remote = await b.open("alice");
    hubA.send("alice", new Uint8Array([9, 8, 7]));
    expect([...new Uint8Array((await remote.next()) as ArrayBuffer)]).toEqual([
      9, 8, 7,
    ]);
  });

  it("hubs with different names ignore each other on a shared transport", async () => {
    class OtherSockets extends WsHub {}
    const transport = createMemoryTransport<WsTransportMessage>();
    const chat = new ChatSockets({ transport });
    const other = new OtherSockets({ transport });
    const { open } = hubServer(other);
    const client = await open("alice");
    chat.send("alice", "wrong hub");
    await expectSilence(client);
  });

  it("explicit names survive minification-style anonymous classes", () => {
    const Anon = class extends WsHub {};
    expect(new Anon({ name: "chat" }).name).toEqual("chat");
  });
});
