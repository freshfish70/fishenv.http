import { describe, expect, expectTypeOf, it } from "bun:test";
import * as v from "valibot";
import { c } from "../../contract/index.ts";
import { ForbiddenError, r } from "../../core/index.ts";
import {
  connectChannels,
  silentLogger,
  startServer,
  useServers,
} from "../_test_utils.ts";
import { WsHub } from "../hub.ts";
import { withWs } from "../router.ts";
import { channel } from "./channel.ts";

useServers();

// ── The shared contract (would live in its own package) ───────────────

const Message = v.object({
  id: v.string(),
  from: v.string(),
  text: v.string(),
});

const room = c
  .channel("rooms/:roomId")
  .param("roomId", v.pipe(v.string(), v.regex(/^\d+$/), v.transform(Number)))
  .join(
    v.object({ lastSeen: v.optional(v.number()) }),
    v.object({ history: v.array(Message) }),
    [ForbiddenError],
  )
  .clientEvent(
    "message",
    v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
    v.object({ id: v.string() }),
  )
  .clientEvent("typing", v.object({}))
  .serverEvent("message", Message)
  .serverEvent("typing", v.object({ userId: v.string() }));

const notifications = c
  .channel("users/:userId/notifications")
  .join()
  .serverEvent("notification", v.object({ title: v.string() }));

const socket = c.ws("/socket").channels(room, notifications);

type AppCtx = { user: string };

function api() {
  return withWs(
    r().use(({ req }) => ({
      user: new URL(req.url).searchParams.get("user") ?? "anon",
    })),
  );
}

const ch = channel.withContext<AppCtx>();

const roomImpl = ch(room)
  .join(({ path, data, ctx }) => {
    expectTypeOf(path.roomId).toEqualTypeOf<number>();
    expectTypeOf(data).toEqualTypeOf<{ lastSeen?: number | undefined }>();
    expectTypeOf(ctx.user).toEqualTypeOf<string>();
    return {
      history: [{ id: "m0", from: "sys", text: `room ${path.roomId}` }],
    };
  })
  .on("message", ({ data, ctx, channel }) => {
    expectTypeOf(data).toEqualTypeOf<{ text: string }>();
    const msg = { id: crypto.randomUUID(), from: ctx.user, text: data.text };
    channel.broadcast("message", msg);
    return { id: msg.id };
  })
  .on("typing", ({ ctx, channel }) => {
    channel.broadcastFrom("typing", { userId: ctx.user });
  });

const notificationsImpl = ch(notifications).join(({ path, ctx }) => {
  if (path.userId !== ctx.user) throw new ForbiddenError();
});

// ── Runtime ───────────────────────────────────────────────────────────

describe("contract channels end-to-end", () => {
  it("implements the contract: join reply, typed events, broadcasts", async () => {
    const hub = new WsHub({ name: "contract-chat" });
    const app = api();
    app.ws(socket).channels([roomImpl, notificationsImpl], { hub });
    const { url } = startServer(app);

    const alice = await connectChannels(url("/socket?user=alice"));
    const bob = await connectChannels(url("/socket?user=bob"));
    expect((await alice.join("rooms/7", {})).d).toEqual({
      history: [{ id: "m0", from: "sys", text: "room 7" }],
    });
    await bob.join("rooms/7", { lastSeen: 3 });

    const reply = await alice.push("rooms/7", "message", { text: "hello" });
    expect(reply.ok).toEqual(true);
    const event = await bob.nextEvent("rooms/7", "message");
    expect(event.d).toEqual({ id: reply.d.id, from: "alice", text: "hello" });

    await alice.push("rooms/7", "typing", {});
    expect((await bob.nextEvent("rooms/7", "typing")).d).toEqual({
      userId: "alice",
    });

    // per-user notification channel authorization
    expect((await alice.join("users/alice/notifications")).ok).toEqual(true);
    expect((await alice.join("users/bob/notifications")).err.code).toEqual(
      "forbidden",
    );

    // typed server push
    hub
      .channel(notifications, "users/alice/notifications")
      .send("notification", { title: "Shipped" });
    expect(
      (await alice.nextEvent("users/alice/notifications", "notification")).d,
    ).toEqual({ title: "Shipped" });
  });

  it("validates client payloads against the contract", async () => {
    const app = api();
    app.ws(socket).channels([roomImpl, notificationsImpl]);
    const { url } = startServer(app);
    const c1 = await connectChannels(url("/socket"));
    await c1.join("rooms/1", {});
    const reply = await c1.push("rooms/1", "message", { text: "" });
    expect(reply.err.code).toEqual("validation_error");
    expect((await c1.join("rooms/x", {})).err.code).toEqual("validation_error");
  });

  it("development mode validates replies and server events; production doesn't", async () => {
    const sloppy = ch(room)
      .join(() => ({ history: "not an array" }) as never)
      .on("message", ({ channel }) => {
        channel.broadcast("message", { id: 1 } as never);
        return { id: "x" };
      })
      .on("typing", ({ channel }) => {
        channel.push("undeclared" as never, {} as never);
      });

    for (const development of [true, false]) {
      const app = api();
      app.ws(socket).channels([sloppy, notificationsImpl]);
      const { url } = startServer(app, { development, logger: silentLogger() });
      const client = await connectChannels(url("/socket"));

      const join = await client.join("rooms/1", {});
      if (development) {
        expect(join.ok).toEqual(false);
        expect(join.err.message).toContain("does not match the contract");
      } else {
        expect(join.ok).toEqual(true);
        const reply = await client.push("rooms/1", "message", { text: "x" });
        expect(reply.ok).toEqual(true);
      }
      await client.close();
    }

    // the server-event checks, once joined (dev)
    const joinsFine = ch(room)
      .join(() => ({ history: [] }))
      .on("message", ({ channel }) => {
        channel.broadcast("message", { id: 1 } as never);
        return { id: "x" };
      })
      .on("typing", ({ channel }) => {
        channel.push("undeclared" as never, {} as never);
      });
    const app = api();
    app.ws(socket).channels([joinsFine, notificationsImpl]);
    const { url } = startServer(app, {
      development: true,
      logger: silentLogger(),
    });
    const client = await connectChannels(url("/socket"));
    await client.join("rooms/1", {});
    expect(
      (await client.push("rooms/1", "message", { text: "x" })).err.message,
    ).toContain('serverEvent "message" does not match the contract');
    expect((await client.push("rooms/1", "typing", {})).err.message).toContain(
      "is not a server event",
    );
  });
});

// ── Completeness at build() (the runtime twin of the type checks) ─────

describe("completeness is enforced at build()", () => {
  const build = (fn: (app: ReturnType<typeof api>) => void) => () => {
    const app = api();
    fn(app);
    app.build();
  };

  it("a missing event handler fails", () => {
    const partial = ch(room).join(() => ({ history: [] }));
    expect(
      build((app) =>
        app.ws("/s").channels([
          // @ts-expect-error — missing .on("message") / .on("typing")
          partial,
        ]),
      ),
    ).toThrow(/missing \.on\("message"\)/);
  });

  it("a missing join authorizer fails", () => {
    const noJoin = ch(notifications);
    expect(
      build((app) =>
        app.ws("/s").channels([
          // @ts-expect-error — missing .join() or .public()
          noJoin,
        ]),
      ),
    ).toThrow(/no join authorizer/);
  });

  it("a contract channel without implementation fails", () => {
    expect(
      build((app) =>
        app
          .ws(socket)
          // @ts-expect-error — notifications is not implemented
          .channels([roomImpl]),
      ),
    ).toThrow(/"users\/:userId\/notifications" is not implemented/);
  });

  it("an implementation outside the socket contract fails", () => {
    const extra = ch(c.channel("extra").join()).public();
    expect(
      build((app) =>
        app
          .ws(socket)
          // @ts-expect-error — "extra" is not part of the socket contract
          .channels([roomImpl, notificationsImpl, extra]),
      ),
    ).toThrow(/"extra" is not part of the socket contract/);
  });

  it("implementing a different contract object with the same name fails", () => {
    const lookalike = ch(
      c.channel("users/:userId/notifications").join(),
    ).public();
    expect(
      build((app) => app.ws(socket).channels([roomImpl, lookalike])),
    ).toThrow(/different contract object/);
  });

  it("the same channel twice fails", () => {
    const lobby = channel("lobby").public();
    expect(build((app) => app.ws("/s").channels([lobby, lobby]))).toThrow(
      /implemented twice/,
    );
  });

  it("contract impls reject inline-only methods", () => {
    expect(() =>
      ch(room).on("extra" as never, v.string() as never, () => {}),
    ).toThrow(/only available on inline channels/);
    expect(() => ch(room).on("nope" as never, (() => {}) as never)).toThrow(
      /not a client event of the contract/,
    );
  });
});

// ── Types ─────────────────────────────────────────────────────────────

describe("types", () => {
  it("ctx requirements of impls must be met by the route", () => {
    const needsTenant = channel.withContext<{ tenant: string }>()("t").public();
    const app = api();
    // @ts-expect-error — the route ctx has no `tenant`
    app.ws("/a").channels([needsTenant]);

    const ok = channel.withContext<{ user: string }>()("u").public();
    app.ws("/b").channels([ok]);
  });

  it("the callback form types ctx from the route, including route middleware", () => {
    const app = api();
    app
      .ws("/cb")
      .with(() => ({ role: "admin" as const }))
      .channels((channel) => [
        channel("admin").join(({ ctx }) => {
          expectTypeOf(ctx.user).toEqualTypeOf<string>();
          expectTypeOf(ctx.role).toEqualTypeOf<"admin">();
        }),
      ]);
  });

  it("server events and replies are type-checked against the contract", () => {
    ch(room)
      .join(() => ({ history: [] }))
      .on("message", ({ channel }) => {
        // @ts-expect-error — wrong payload shape
        channel.broadcast("message", { id: 1 });
        // @ts-expect-error — not a declared server event
        channel.broadcast("nope", {});
        return { id: "ok" };
      });

    ch(room)
      .join(() => ({ history: [] }))
      // @ts-expect-error — the reply must match { id: string }
      .on("message", () => ({ wrong: true }));

    // @ts-expect-error — the join reply must match { history: Message[] }
    ch(room).join(() => ({ history: "nope" }));
  });
});
