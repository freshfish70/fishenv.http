import { describe, expect, it } from "bun:test";
import * as v from "valibot";
import {
  createMemoryTransport,
  ForbiddenError,
  r,
  UnprocessableEntityError,
} from "../../core/index.ts";
import {
  connect,
  connectChannels,
  connectRejected,
  silentLogger,
  startServer,
  useServers,
  waitFor,
} from "../_test_utils.ts";
import { WsHub, type WsTransportMessage } from "../hub.ts";
import { withWs } from "../router.ts";
import { WsCloseError } from "../types.ts";
import { type AnyChannelImpl, channel, type LeaveReason } from "./channel.ts";
import type { ChannelsOptions } from "./handler.ts";

useServers();

class ChatHub extends WsHub {}

/** Root router whose ctx.user comes from `?user=`. */
function app() {
  return withWs(
    r().use(({ req }) => ({
      user: new URL(req.url).searchParams.get("user") ?? "anon",
    })),
  );
}

const room = channel
  .withContext<{ user: string }>()("rooms/:roomId")
  .param("roomId", v.pipe(v.string(), v.regex(/^\d+$/), v.transform(Number)))
  .join(v.object({ secret: v.optional(v.string()) }), ({ path, data, ctx }) => {
    if (path.roomId === 13) throw new ForbiddenError("Room 13 is private");
    if (data.secret === "boom") throw new Error("db password=hunter2");
    return { roomId: path.roomId, you: ctx.user };
  })
  .on(
    "say",
    v.object({ text: v.pipe(v.string(), v.maxLength(20)) }),
    ({ data, ctx, channel }) => {
      channel.broadcast("said", { from: ctx.user, text: data.text });
      return { ok: true };
    },
  )
  .on("whisper", v.object({ text: v.string() }), ({ data, channel }) => {
    channel.broadcastFrom("whispered", data.text);
  })
  .on("echo", v.unknown(), ({ data, channel }) => {
    channel.push("echoed", data);
  })
  .on("fail", v.object({}), () => {
    throw new UnprocessableEntityError("Nope");
  })
  .on("crash", v.object({}), () => {
    throw new Error("secret internals");
  })
  .on("kill", v.object({}), () => {
    throw new WsCloseError(4100, "killed");
  })
  .on("leaveMe", v.object({}), ({ channel }) => {
    channel.leave("bye");
  });

/** Start a server for `impls` and return a connect helper. */
function start(
  impls: readonly AnyChannelImpl[] = [room],
  options: ChannelsOptions & { development?: boolean } = {},
) {
  const { development, ...channelOptions } = options;
  const logger = silentLogger();
  const api = app();
  api.ws("/socket").channels(impls as never, channelOptions);
  const server = startServer(api, { logger, development });
  return {
    ...server,
    logger,
    client: (user = "alice") =>
      connectChannels(server.url(`/socket?user=${user}`)),
  };
}

// ── Handshake ─────────────────────────────────────────────────────────

describe("channel socket handshake", () => {
  it("negotiates fishenv.channels.v1", async () => {
    const { client } = start();
    const c = await client();
    expect(c.raw.ws.protocol).toEqual("fishenv.channels.v1");
    await c.close();
  });

  it("rejects clients that don't offer the protocol", async () => {
    const { url } = start();
    expect(await connectRejected(url("/socket"))).toEqual("rejected");
  });
});

// ── Join ──────────────────────────────────────────────────────────────

describe("join", () => {
  it("replies with the join handler's return value; params are coerced", async () => {
    const { client } = start();
    const c = await client("alice");
    expect(await c.join("rooms/42", {})).toEqual({
      t: "reply",
      ref: 1,
      ok: true,
      d: { roomId: 42, you: "alice" },
    });
    await c.close();
  });

  it("a throwing authorizer refuses the join with the error's status/code", async () => {
    const { client } = start();
    const c = await client();
    const reply = await c.join("rooms/13", {});
    expect(reply.ok).toEqual(false);
    expect(reply.err).toEqual({
      status: 403,
      code: "forbidden",
      message: "Room 13 is private",
    });
    // not joined → events are rejected
    expect((await c.push("rooms/13", "say", { text: "hi" })).err.code).toEqual(
      "not_joined",
    );
    await c.close();
  });

  it("unknown errors become 500 internal without details", async () => {
    const { client, logger } = start();
    const c = await client();
    const reply = await c.join("rooms/1", { secret: "boom" });
    expect(reply.err).toEqual({
      status: 500,
      code: "internal",
      message: "Internal Server Error",
    });
    expect(JSON.stringify(reply)).not.toContain("hunter2");
    expect(logger.errors).toHaveLength(1);
    await c.close();
  });

  it("development mode includes the message and stack", async () => {
    const { client } = start([room], { development: true });
    const c = await client();
    const reply = await c.join("rooms/1", { secret: "boom" });
    expect(reply.err.message).toEqual("db password=hunter2");
    expect(reply.err.stack).toBeString();
    await c.close();
  });

  it.each([
    ["unknown channel", "lobby", {}, 404, "unknown_channel"],
    ["param validation", "rooms/abc", {}, 400, "validation_error"],
    ["payload validation", "rooms/1", { secret: 5 }, 400, "validation_error"],
  ])("%s → %d %s", async (_label, ch, d, status, code) => {
    const { client } = start();
    const c = await client();
    const reply = await c.join(ch, d);
    expect(reply.ok).toEqual(false);
    expect(reply.err.status).toEqual(status);
    expect(reply.err.code).toEqual(code);
    await c.close();
  });

  it("validation errors carry issue details", async () => {
    const { client } = start();
    const c = await client();
    const reply = await c.join("rooms/1", { secret: 5 });
    expect(reply.err.details.field).toEqual("body");
    expect(reply.err.details.issues[0].path).toEqual(["secret"]);
    await c.close();
  });

  it("joining twice is rejected with already_joined", async () => {
    const { client } = start();
    const c = await client();
    await c.join("rooms/1", {});
    expect((await c.join("rooms/1", {})).err.code).toEqual("already_joined");
    await c.close();
  });

  it("maxChannelsPerSocket caps joins with 429", async () => {
    const { client } = start([room], { maxChannelsPerSocket: 2 });
    const c = await client();
    await c.join("rooms/1", {});
    await c.join("rooms/2", {});
    const reply = await c.join("rooms/3", {});
    expect(reply.err).toMatchObject({ status: 429, code: "too_many_channels" });
    await c.close();
  });

  it("public() channels join without an authorizer", async () => {
    const lobby = channel("lobby").public();
    const { client } = start([lobby]);
    const c = await client();
    expect((await c.join("lobby")).ok).toEqual(true);
    await c.close();
  });
});

// ── Events ────────────────────────────────────────────────────────────

describe("events", () => {
  it("broadcast reaches every member including the sender; reply goes to the sender", async () => {
    const { client } = start();
    const alice = await client("alice");
    const bob = await client("bob");
    const carol = await client("carol");
    await alice.join("rooms/1", {});
    await bob.join("rooms/1", {});
    await carol.join("rooms/2", {});

    expect(await alice.push("rooms/1", "say", { text: "hi" })).toMatchObject({
      ok: true,
      d: { ok: true },
    });
    const expected = {
      t: "event",
      ch: "rooms/1",
      ev: "said",
      d: { from: "alice", text: "hi" },
    };
    expect(await alice.nextEvent("rooms/1", "said")).toEqual(expected);
    expect(await bob.nextEvent("rooms/1", "said")).toEqual(expected);
    await Bun.sleep(30);
    expect(carol.unread).toEqual([]);
  });

  it("broadcastFrom excludes the sender; push reaches only the sender", async () => {
    const { client } = start();
    const alice = await client("alice");
    const bob = await client("bob");
    await alice.join("rooms/1", {});
    await bob.join("rooms/1", {});

    await alice.push("rooms/1", "whisper", { text: "psst" });
    expect((await bob.nextEvent("rooms/1", "whispered")).d).toEqual("psst");

    await alice.push("rooms/1", "echo", [1, 2]);
    expect((await alice.nextEvent("rooms/1", "echoed")).d).toEqual([1, 2]);
    await Bun.sleep(30);
    expect(alice.unread.filter((f) => f.ev === "whispered")).toEqual([]);
    expect(bob.unread.filter((f) => f.ev === "echoed")).toEqual([]);
  });

  it("events without a ref get no reply", async () => {
    const { client } = start();
    const c = await client();
    await c.join("rooms/1", {});
    c.send({ t: "event", ch: "rooms/1", ev: "say", d: { text: "x" } });
    await c.nextEvent("rooms/1", "said");
    await Bun.sleep(20);
    expect(c.unread.filter((f) => f.t === "reply")).toEqual([]);
    await c.close();
  });

  it("failures of ref-less frames are reported as error frames", async () => {
    const { client } = start();
    const c = await client();
    await c.join("rooms/1", {});
    c.send({ t: "event", ch: "rooms/1", ev: "fail", d: {} });
    const frame = await c.waitFrame((f) => f.t === "error");
    expect(frame).toEqual({
      t: "error",
      ch: "rooms/1",
      err: { status: 422, code: "unprocessable_entity", message: "Nope" },
    });
    await c.close();
  });

  it.each([
    ["not joined", "rooms/9", "say", { text: "x" }, "not_joined"],
    ["unknown event", "rooms/1", "nope", {}, "unknown_event"],
    [
      "invalid payload",
      "rooms/1",
      "say",
      { text: "x".repeat(21) },
      "validation_error",
    ],
    ["HttpError", "rooms/1", "fail", {}, "unprocessable_entity"],
    ["unknown error", "rooms/1", "crash", {}, "internal"],
  ])("%s → %s", async (_label, ch, ev, d, code) => {
    const { client } = start();
    const c = await client();
    await c.join("rooms/1", {});
    const reply = await c.push(ch, ev, d);
    expect(reply.ok).toEqual(false);
    expect(reply.err.code).toEqual(code);
    await c.close();
  });

  it("WsCloseError from a handler closes the whole socket", async () => {
    const { client } = start();
    const c = await client();
    await c.join("rooms/1", {});
    c.send({ t: "event", ch: "rooms/1", ev: "kill", d: {} });
    expect(await c.raw.closed).toEqual({ code: 4100, reason: "killed" });
  });

  it("onAny receives undeclared events unvalidated", async () => {
    const proxy = channel("proxy")
      .public()
      .onAny(({ event, data }) => ({ event, data }));
    const { client } = start([proxy]);
    const c = await client();
    await c.join("proxy");
    expect((await c.push("proxy", "anything", { x: 1 })).d).toEqual({
      event: "anything",
      data: { x: 1 },
    });
    await c.close();
  });
});

// ── Ordering & limits ─────────────────────────────────────────────────

describe("ordering and abuse limits", () => {
  it("frames are processed sequentially: an event right after a slow join sees the join", async () => {
    const slow = channel("slow")
      .join(async () => {
        await Bun.sleep(60);
        return "joined";
      })
      .on("ping", v.unknown(), () => "pong");
    const { client } = start([slow]);
    const c = await client();
    c.send({ t: "join", ref: 100, ch: "slow" });
    c.send({ t: "event", ref: 101, ch: "slow", ev: "ping" });
    expect(await c.waitFrame((f) => f.ref === 100)).toMatchObject({
      ok: true,
      d: "joined",
    });
    expect(await c.waitFrame((f) => f.ref === 101)).toMatchObject({
      ok: true,
      d: "pong",
    });
    await c.close();
  });

  it("malformed frames get bad_request replies", async () => {
    const { client } = start();
    const c = await client();
    c.raw.send("{nope");
    expect((await c.waitFrame((f) => f.t === "error")).err.code).toEqual(
      "bad_request",
    );
    c.send({ t: "join", ref: 5 }); // missing channel
    expect(await c.waitFrame((f) => f.ref === 5)).toMatchObject({
      ok: false,
      err: { code: "bad_request", message: "Invalid channel name" },
    });
    c.raw.send(new Uint8Array([1, 2, 3]));
    expect((await c.waitFrame((f) => f.t === "error")).err.message).toEqual(
      "Binary frames are not supported",
    );
    await c.close();
  });

  it("repeated protocol violations close the socket with 1008", async () => {
    const { client } = start([room], { maxViolations: 3 });
    const c = await client();
    for (let i = 0; i < 3; i++) c.send({ t: "join", ch: "unknown" });
    expect(await c.raw.closed).toEqual({
      code: 1008,
      reason: "Too many protocol violations",
    });
  });

  it("authorization failures are not counted as violations", async () => {
    const { client } = start([room], { maxViolations: 2 });
    const c = await client();
    for (let i = 0; i < 4; i++) await c.join("rooms/13", {});
    expect(c.raw.ws.readyState).toEqual(WebSocket.OPEN);
    await c.close();
  });

  it("too many frames queued behind a slow handler close with 1013", async () => {
    const stuck = channel("stuck").join(() => new Promise(() => {}));
    const { client } = start([stuck], { maxPendingFrames: 3 });
    const c = await client();
    for (let i = 0; i < 5; i++) c.send({ t: "join", ch: "stuck" });
    expect((await c.raw.closed).code).toEqual(1013);
  });
});

// ── Leave, disconnect, kick ───────────────────────────────────────────

describe("leaving", () => {
  function tracked() {
    const reasons: LeaveReason[] = [];
    const ch = channel("tracked/:id")
      .public()
      .on("noop", v.unknown(), () => {})
      .leave(({ reason, path }) => {
        reasons.push(reason);
        expect(path.id).toBeString();
      });
    return { ch, reasons };
  }

  it("client leave: reply, leave handler with 'client', no more broadcasts", async () => {
    const { ch, reasons } = tracked();
    const hub = new ChatHub();
    const { client } = start([ch], { hub });
    const c = await client();
    await c.join("tracked/1");
    expect((await c.leave("tracked/1")).ok).toEqual(true);
    expect(reasons).toEqual(["client"]);

    hub.channel("tracked/1").send("x", 1);
    await Bun.sleep(30);
    expect(c.unread).toEqual([]);
    expect((await c.leave("tracked/1")).err.code).toEqual("not_joined");
    await c.close();
  });

  it("disconnect runs every leave handler with 'disconnect'", async () => {
    const { ch, reasons } = tracked();
    const { client } = start([ch]);
    const c = await client();
    await c.join("tracked/1");
    await c.join("tracked/2");
    await c.close();
    await waitFor(() => reasons.length === 2, "leave handlers");
    expect(reasons).toEqual(["disconnect", "disconnect"]);
  });

  it("hub kick notifies the client, runs leave('kicked') and stops delivery", async () => {
    const { ch, reasons } = tracked();
    const hub = new ChatHub();
    const { client } = start([ch], { hub });
    const alice = await client("alice");
    const bob = await client("bob");
    await alice.join("tracked/1");
    await bob.join("tracked/1");
    hub.add("alice", hub.channel("tracked/1").sockets()[0]!);

    expect(hub.channel("tracked/1").to("alice").kick("removed")).toEqual(1);
    expect(await alice.waitFrame((f) => f.t === "close")).toEqual({
      t: "close",
      ch: "tracked/1",
      reason: "removed",
    });
    await waitFor(() => reasons.includes("kicked"), "kicked leave");

    hub.channel("tracked/1").send("after", 1);
    expect((await bob.nextEvent("tracked/1", "after")).d).toEqual(1);
    await Bun.sleep(20);
    expect(alice.unread.filter((f) => f.ev === "after")).toEqual([]);
    // can re-join after a kick
    expect((await alice.join("tracked/1")).ok).toEqual(true);
  });

  it("channel.leave() from a handler is a server-initiated leave", async () => {
    const { client } = start();
    const c = await client();
    await c.join("rooms/1", {});
    await c.push("rooms/1", "leaveMe", {});
    expect(await c.waitFrame((f) => f.t === "close")).toMatchObject({
      ch: "rooms/1",
      reason: "bye",
    });
    expect((await c.push("rooms/1", "say", { text: "x" })).err.code).toEqual(
      "not_joined",
    );
    await c.close();
  });
});

// ── Server-side access via the hub ────────────────────────────────────

describe("hub.channel(name)", () => {
  it("sends to channel members from server code, optionally by key", async () => {
    const hub = new ChatHub();
    const api = app();
    api.ws("/socket").channels([room], { hub });
    const { url } = startServer(api);

    const alice = await connectChannels(url("/socket?user=alice"));
    const bob = await connectChannels(url("/socket?user=bob"));
    await alice.join("rooms/1", {});
    await bob.join("rooms/1", {});
    const [aSock, bSock] = hub.channel("rooms/1").sockets();
    hub.add("alice", aSock!);
    hub.add("bob", bSock!);

    expect(hub.channel("rooms/1").send("notice", { n: 1 })).toEqual(2);
    expect((await alice.nextEvent("rooms/1", "notice")).d).toEqual({ n: 1 });
    expect((await bob.nextEvent("rooms/1", "notice")).d).toEqual({ n: 1 });

    expect(hub.channel("rooms/1").to("bob").send("dm", "hi bob")).toEqual(1);
    expect((await bob.nextEvent("rooms/1", "dm")).d).toEqual("hi bob");
    await Bun.sleep(20);
    expect(alice.unread).toEqual([]);
    expect(hub.channel("rooms/1").count()).toEqual(2);
  });

  it("resolves the hub from the DI container when given a token", async () => {
    const hub = new ChatHub();
    const api = app();
    api.ws("/socket").channels([room], { hub: ChatHub });
    const { url } = startServer(api, {
      container: { get: () => hub } as never,
    });
    const c = await connectChannels(url("/socket"));
    await c.join("rooms/5", {});
    hub.channel("rooms/5").send("x", true);
    expect((await c.nextEvent("rooms/5", "x")).d).toEqual(true);
    await c.close();
  });

  it("broadcasts and kicks cross nodes over the transport", async () => {
    const transport = createMemoryTransport<WsTransportMessage>();
    const hubA = new ChatHub({ transport });
    const hubB = new ChatHub({ transport });
    const reasons: string[] = [];
    const ch = room.leave(({ reason }) => void reasons.push(reason));

    const apiA = app();
    apiA.ws("/socket").channels([ch], { hub: hubA });
    const apiB = app();
    apiB.ws("/socket").channels([ch], { hub: hubB });
    const a = startServer(apiA);
    const b = startServer(apiB);

    const alice = await connectChannels(a.url("/socket?user=alice"));
    const bob = await connectChannels(b.url("/socket?user=bob"));
    await alice.join("rooms/1", {});
    await bob.join("rooms/1", {});

    await alice.push("rooms/1", "say", { text: "cross" });
    expect((await bob.nextEvent("rooms/1", "said")).d).toEqual({
      from: "alice",
      text: "cross",
    });

    hubA.channel("rooms/1").kick("everyone out");
    expect((await bob.waitFrame((f) => f.t === "close")).reason).toEqual(
      "everyone out",
    );
    expect((await alice.waitFrame((f) => f.t === "close")).reason).toEqual(
      "everyone out",
    );
    await waitFor(() => reasons.length === 2, "kicked leaves");
  });
});

// ── Raw socket compatibility ──────────────────────────────────────────

describe("route-level limits still apply", () => {
  it("rateLimit on the ws route throttles channel frames", async () => {
    const api = app();
    api
      .ws("/socket")
      .rateLimit({ messages: 3, perMs: 10_000 })
      .channels([room]);
    const { url } = startServer(api);
    const c = await connect(url("/socket"), "fishenv.channels.v1");
    for (let i = 0; i < 5; i++) c.sendJson({ t: "join", ch: "lobby" });
    expect((await c.closed).code).toEqual(1008);
  });
});
