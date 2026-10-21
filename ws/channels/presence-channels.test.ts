import { describe, expect, expectTypeOf, it } from "bun:test";
import * as v from "valibot";
import { c } from "../../contract/index.ts";
import { createMemoryTransport, r } from "../../core/index.ts";
import {
  type ChannelClient,
  connectChannels,
  silentLogger,
  startServer,
  useServers,
  waitFor,
} from "../_test_utils.ts";
import { WsHub, type WsTransportMessage } from "../hub.ts";
import { withWs } from "../router.ts";
import { channel } from "./channel.ts";

useServers();

const Meta = v.object({ status: v.picklist(["online", "away"]) });

const doc = c
  .channel("docs/:docId")
  .join(v.object({ hidden: v.optional(v.boolean()) }))
  .clientEvent("who", v.object({}), v.array(v.string()))
  .presence(Meta, { clientUpdates: true });

const readOnly = c.channel("feeds/:id").join().presence(Meta);

const noPresence = c.channel("plain").join();

const ch = channel.withContext<{ user: string }>();

const docImpl = ch(doc)
  .join(() => {})
  .presence(({ ctx, data }) =>
    data.hidden ? null : { key: ctx.user, meta: { status: "online" } },
  )
  .on("who", ({ channel }) => {
    expectTypeOf(channel.presence.list).returns.toEqualTypeOf<
      Record<string, { ref: string; meta: { status: "online" | "away" } }[]>
    >();
    return channel.presence.keys().sort();
  });

const feedImpl = ch(readOnly)
  .join(() => {})
  .presence(({ ctx }) => ({ key: ctx.user, meta: { status: "online" } }));

const plainImpl = ch(noPresence).join(({ channel }) => {
  expectTypeOf(channel.presence).toEqualTypeOf<undefined>();
});

function app(hub: WsHub) {
  const api = withWs(
    r().use(({ req }) => ({
      user: new URL(req.url).searchParams.get("user") ?? "anon",
    })),
  );
  api.ws("/socket").channels([docImpl, feedImpl, plainImpl], { hub });
  return api;
}

function setup(hub = new WsHub({ name: "docs", presence: { batchMs: 5 } })) {
  const { url } = startServer(app(hub), { logger: silentLogger() });
  return {
    hub,
    as: (user: string) => connectChannels(url(`/socket?user=${user}`)),
  };
}

const keysOf = (state: Record<string, unknown>) => Object.keys(state).sort();

/** Next presence_diff for `ch` (diffs are batched). */
const nextDiff = (client: ChannelClient, ch: string) =>
  client.waitFrame((f) => f.t === "presence_diff" && f.ch === ch);

describe("channel presence", () => {
  it("join → reply, then presence_state including yourself", async () => {
    const { as } = setup();
    const alice = await as("alice");
    expect((await alice.join("docs/1", {})).ok).toEqual(true);
    const state = await alice.waitFrame((f) => f.t === "presence_state");
    expect(state.ch).toEqual("docs/1");
    expect(state.d.alice).toEqual([
      { ref: expect.any(String), meta: { status: "online" } },
    ]);
  });

  it("other members receive batched join and leave diffs", async () => {
    const { as } = setup();
    const alice = await as("alice");
    await alice.join("docs/1", {});
    await nextDiff(alice, "docs/1"); // her own join

    const bob = await as("bob");
    await bob.join("docs/1", {});
    const state = await bob.waitFrame((f) => f.t === "presence_state");
    expect(keysOf(state.d)).toEqual(["alice", "bob"]);

    const joined = await nextDiff(alice, "docs/1");
    expect(keysOf(joined.joins)).toEqual(["bob"]);
    expect(joined.leaves).toEqual({});

    await bob.leave("docs/1");
    const left = await nextDiff(alice, "docs/1");
    expect(keysOf(left.leaves)).toEqual(["bob"]);
  });

  it("closing one of several tabs only removes that ref", async () => {
    const { as, hub } = setup();
    const observer = await as("observer");
    await observer.join("docs/1", {});
    const tab1 = await as("alice");
    const tab2 = await as("alice");
    await tab1.join("docs/1", {});
    await tab2.join("docs/1", {});
    await waitFor(
      () => hub.channel("docs/1").presence.list().alice?.length === 2,
      "two alice tabs",
    );

    await tab1.close();
    await waitFor(
      () => hub.channel("docs/1").presence.list().alice?.length === 1,
      "one alice tab",
    );
    expect(hub.channel("docs/1").presence.has("alice")).toEqual(true);

    await tab2.close();
    await waitFor(
      () => !hub.channel("docs/1").presence.has("alice"),
      "alice gone",
    );
  });

  it("a tracker returning null joins without being tracked", async () => {
    const { as, hub } = setup();
    const ghost = await as("ghost");
    await ghost.join("docs/1", { hidden: true });
    const state = await ghost.waitFrame((f) => f.t === "presence_state");
    expect(state.d).toEqual({});
    expect(hub.channel("docs/1").presence.has("ghost")).toEqual(false);
    expect(hub.channel("docs/1").count()).toEqual(1); // still a member
  });

  it("handlers read presence via channel.presence", async () => {
    const { as } = setup();
    const alice = await as("alice");
    const bob = await as("bob");
    await alice.join("docs/1", {});
    await bob.join("docs/1", {});
    expect((await alice.push("docs/1", "who", {})).d).toEqual(["alice", "bob"]);
  });

  it("channels without presence send no presence frames", async () => {
    const { as } = setup();
    const c1 = await as("alice");
    await c1.join("plain");
    await Bun.sleep(30);
    expect(c1.unread.filter((f) => f.t.startsWith("presence"))).toEqual([]);
  });
});

describe("client presence updates", () => {
  it("update meta → diff to everyone (leave old + join new)", async () => {
    const { as, hub } = setup();
    const alice = await as("alice");
    const bob = await as("bob");
    await alice.join("docs/1", {});
    await bob.join("docs/1", {});
    await waitFor(() => hub.channel("docs/1").presence.count() === 2, "both");
    // drain earlier diffs
    await Bun.sleep(20);
    while (bob.unread.some((f) => f.t === "presence_diff")) {
      await nextDiff(bob, "docs/1");
    }

    const reply = await alice.request({
      t: "presence_update",
      ch: "docs/1",
      d: { status: "away" },
    });
    expect(reply.ok).toEqual(true);
    const diff = await nextDiff(bob, "docs/1");
    expect(diff.joins.alice[0].meta).toEqual({ status: "away" });
    expect(diff.leaves.alice[0].meta).toEqual({ status: "online" });
  });

  it("validates meta, rate limits, and requires clientUpdates + tracking", async () => {
    const { as } = setup();
    const alice = await as("alice");
    await alice.join("docs/1", {});
    await alice.join("feeds/1");

    const update = (ch: string, d: unknown) =>
      alice.request({ t: "presence_update", ch, d });

    expect((await update("docs/1", { status: "invisible" })).err.code).toEqual(
      "validation_error",
    );
    expect((await update("docs/1", { status: "away" })).ok).toEqual(true);
    expect((await update("docs/1", { status: "online" })).err.code).toEqual(
      "rate_limited",
    );
    expect((await update("feeds/1", { status: "away" })).err.code).toEqual(
      "forbidden",
    );
    expect((await update("docs/9", { status: "away" })).err.code).toEqual(
      "not_joined",
    );

    const ghost = await as("ghost");
    await ghost.join("docs/2", { hidden: true });
    expect(
      (
        await ghost.request({
          t: "presence_update",
          ch: "docs/2",
          d: { status: "away" },
        })
      ).err.code,
    ).toEqual("not_tracked");
  });
});

describe("server-side presence", () => {
  it("hub.channel(name).presence lists and targets users", async () => {
    const { as, hub } = setup();
    const alice = await as("alice");
    await alice.join("docs/1", {});
    await waitFor(() => hub.channel("docs/1").presence.has("alice"), "alice");

    expect(hub.channel("docs/1").presence.keys()).toEqual(["alice"]);
    const [socket] = hub.channel("docs/1").sockets();
    hub.add("alice", socket!);
    hub.channel("docs/1").to("alice").send("ping", 1);
    expect((await alice.nextEvent("docs/1", "ping")).d).toEqual(1);
  });

  it("kicked users leave presence", async () => {
    const { as, hub } = setup();
    const alice = await as("alice");
    await alice.join("docs/1", {});
    await waitFor(() => hub.channel("docs/1").presence.has("alice"), "alice");
    hub.channel("docs/1").kick("bye");
    await waitFor(() => !hub.channel("docs/1").presence.has("alice"), "kicked");
  });

  it("development mode rejects off-contract tracker meta", async () => {
    const bad = ch(doc)
      .join(() => {})
      .presence(({ ctx }) => ({
        key: ctx.user,
        meta: { status: "nope" } as never,
      }))
      .on("who", () => []);
    const api = withWs(r().use(() => ({ user: "u" })));
    api.ws("/socket").channels([bad]);
    const { url } = startServer(api, {
      development: true,
      logger: silentLogger(),
    });
    const client = await connectChannels(url("/socket"));
    const reply = await client.join("docs/1", {});
    expect(reply.ok).toEqual(false);
    expect(reply.err.message).toContain("presence meta");
  });
});

describe("presence across nodes", () => {
  it("members on different servers see each other", async () => {
    const transport = createMemoryTransport<WsTransportMessage>();
    const nodeA = setup(
      new WsHub({ name: "docs", transport, presence: { batchMs: 5 } }),
    );
    const nodeB = setup(
      new WsHub({ name: "docs", transport, presence: { batchMs: 5 } }),
    );

    const alice = await nodeA.as("alice");
    await alice.join("docs/1", {});
    await nextDiff(alice, "docs/1");

    const bob = await nodeB.as("bob");
    await bob.join("docs/1", {});
    const state = await bob.waitFrame((f) => f.t === "presence_state");
    expect(keysOf(state.d)).toEqual(["alice", "bob"]);

    const diff = await nextDiff(alice, "docs/1");
    expect(keysOf(diff.joins)).toEqual(["bob"]);

    await bob.close();
    const left = await nextDiff(alice, "docs/1");
    expect(keysOf(left.leaves)).toEqual(["bob"]);
    expect(nodeA.hub.channel("docs/1").presence.keys()).toEqual(["alice"]);
  });
});

describe("presence typing", () => {
  it(".presence() requires contract presence", () => {
    expect(() => ch(noPresence).presence(() => null as never)).toThrow(
      /requires presence in the channel contract/,
    );
  });
});
