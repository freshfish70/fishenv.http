import { expect, test } from "bun:test";
import * as v from "valibot";
import { r, UnauthorizedError } from "../core/index.ts";
import {
  containerOf,
  readEventFrame,
  readFrame,
  waitFor,
} from "./_test_utils.ts";
import { SseHub } from "./hub.ts";
import { withSse } from "./router.ts";

test("withSse: registers a GET route with kind 'sse'", async () => {
  const app = withSse(r());
  const route = app.sse("/events").handle(({ sse }) => {
    sse.send("connected");
  });

  expect(route.definition.kind).toEqual("sse");
  expect(route.definition.method).toEqual("GET");
  expect(route.definition.path).toEqual("/events");

  app.build();
  const res = await app.fetch(new Request("http://localhost/events"));
  const reader = res.body!.getReader();
  expect(await readFrame(reader)).toEqual("data: connected\n\n");
  await reader.cancel();
});

test("withSse: middleware runs before the stream, so errors keep their status", async () => {
  let handlerRan = false;

  const app = withSse(
    r({ prefix: "/api" }).use((ctx) => {
      if (ctx.req.headers.get("authorization") == null) {
        throw new UnauthorizedError("Missing token");
      }
      return { user: { id: "user-1" } };
    }),
  );

  app.sse("/events").handle(({ sse, ctx }) => {
    handlerRan = true;
    sse.send(`hello ${ctx.user.id}`);
  });
  app.build();

  const denied = await app.fetch(new Request("http://localhost/api/events"));
  expect(denied.status).toEqual(401);
  expect(denied.headers.get("content-type")).toStartWith("application/json");
  expect(await denied.json()).toEqual({ error: "Missing token" });
  expect(handlerRan).toBeFalsy();

  const allowed = await app.fetch(
    new Request("http://localhost/api/events", {
      headers: { authorization: "Bearer t" },
    }),
  );
  expect(allowed.status).toEqual(200);
  const reader = allowed.body!.getReader();
  expect(await readFrame(reader)).toEqual("data: hello user-1\n\n");
  await reader.cancel();
});

test("withSse: path params are validated and coerced", async () => {
  const app = withSse(r());
  app
    .sse("/rooms/:roomId/events")
    .param("roomId", v.pipe(v.string(), v.transform(Number), v.number()))
    .handle(({ sse, path }) => {
      sse.send({ room: path.roomId, type: typeof path.roomId });
    });
  app.build();

  const ok = await app.fetch(new Request("http://localhost/rooms/42/events"));
  const reader = ok.body!.getReader();
  expect(await readFrame(reader)).toEqual(
    'data: {"room":42,"type":"number"}\n\n',
  );
  await reader.cancel();

  const bad = await app.fetch(new Request("http://localhost/rooms/abc/events"));
  expect(bad.status).toEqual(400);
  await bad.body?.cancel();
});

test("withSse: .subscribe() registers the connection in a DI-resolved hub", async () => {
  class UserEvents extends SseHub {}
  const userEvents = new UserEvents();
  const container = containerOf(new Map([[UserEvents, userEvents]]));

  // A plain service that pushes to one specific client.
  class NotificationService {
    constructor(private readonly events: UserEvents) {}
    notify(userId: string, body: unknown): number {
      return this.events.send(userId, body, { event: "notification" });
    }
  }
  const notifications = new NotificationService(userEvents);

  const app = withSse(
    r({ prefix: "/api" }).use((ctx) => ({
      user: { id: new URL(ctx.req.url).searchParams.get("as") ?? "anon" },
    })),
  );
  app
    .sse("/events")
    .keepalive(30_000)
    .subscribe(UserEvents, ({ ctx }) => ctx.user.id);

  app._setContainer(container);
  app.build();

  const alice = await app.fetch(
    new Request("http://localhost/api/events?as=alice"),
  );
  const bob = await app.fetch(
    new Request("http://localhost/api/events?as=bob"),
  );
  const aliceReader = alice.body!.getReader();
  const bobReader = bob.body!.getReader();

  // Give the async open callback a turn to register both connections.
  await Promise.resolve();
  expect(userEvents.count()).toEqual(2);

  expect(notifications.notify("alice", { text: "you got mail" })).toEqual(1);
  expect(await readFrame(aliceReader)).toEqual(
    'event: notification\ndata: {"text":"you got mail"}\n\n',
  );

  expect(notifications.notify("carol", { text: "nobody home" })).toEqual(0);

  // Alice disconnects — the hub must drop her without any manual bookkeeping.
  await aliceReader.cancel();
  await Promise.resolve();
  expect(userEvents.count("alice")).toEqual(0);
  expect(userEvents.count()).toEqual(1);

  userEvents.closeAll();
  await bobReader.cancel();
});

test("withSse: handler cleanup runs when the client goes away", async () => {
  let unsubscribed = false;

  const app = withSse(r());
  app.sse("/events").handle(({ sse }) => {
    sse.send("open");
    return () => {
      unsubscribed = true;
    };
  });
  app.build();

  const res = await app.fetch(new Request("http://localhost/events"));
  const reader = res.body!.getReader();
  expect(await readFrame(reader)).toEqual("data: open\n\n");

  await reader.cancel();
  expect(unsubscribed).toBeTruthy();
});

test("withSse: keepalive emits comment heartbeats", async () => {
  const app = withSse(r());
  app
    .sse("/events")
    .keepalive(10)
    .handle(() => {});
  app.build();

  const res = await app.fetch(new Request("http://localhost/events"));
  const reader = res.body!.getReader();

  expect(await readFrame(reader)).toEqual(": ka\n\n");
  expect(await readFrame(reader)).toEqual(": ka\n\n");

  await reader.cancel();
});

test("withSse: a throwing handler closes the stream instead of hanging", async () => {
  const app = withSse(r());
  app.sse("/events").handle(({ sse }) => {
    sse.send("before");
    throw new Error("boom");
  });
  app.build();

  const res = await app.fetch(new Request("http://localhost/events"));
  // Status is already committed — the failure cannot become a 500.
  expect(res.status).toEqual(200);

  const reader = res.body!.getReader();
  expect(await readFrame(reader)).toEqual("data: before\n\n");
  expect((await reader.read()).done).toEqual(true);
});

// ── end-to-end over a real socket ──────────────────────────────────────────

test("e2e: targeted send over a real connection, and disconnect deregisters", async () => {
  class UserEvents extends SseHub {}
  const userEvents = new UserEvents();
  const container = containerOf(new Map([[UserEvents, userEvents]]));

  const app = withSse(
    r().use((ctx) => ({
      user: { id: new URL(ctx.req.url).searchParams.get("as") ?? "anon" },
    })),
  );
  app
    .sse("/events")
    .keepalive(50)
    .subscribe(UserEvents, ({ ctx }) => ctx.user.id);

  app._setContainer(container);
  app.build();

  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: app.fetch });
  const base = `http://localhost:${server.port}/events`;

  const aliceAbort = new AbortController();
  const bobAbort = new AbortController();
  const alice = await fetch(`${base}?as=alice`, {
    signal: aliceAbort.signal,
  });
  const bob = await fetch(`${base}?as=bob`, { signal: bobAbort.signal });

  expect(alice.headers.get("content-type")).toEqual(
    "text/event-stream; charset=utf-8",
  );

  await waitFor(() => userEvents.count() === 2, "both clients registered");

  const aliceReader = alice.body!.getReader();
  const bobReader = bob.body!.getReader();

  expect(userEvents.send("alice", { hello: "alice" }, { event: "dm" })).toEqual(
    1,
  );
  expect(await readEventFrame(aliceReader)).toEqual(
    'event: dm\ndata: {"hello":"alice"}\n\n',
  );

  // Alice drops her connection; the hub must notice without app bookkeeping.
  aliceAbort.abort();
  await waitFor(
    () => userEvents.count("alice") === 0,
    "alice deregistered after disconnect",
  );
  expect(userEvents.count()).toEqual(1);

  // Sending to a gone client is a harmless no-op, and Bob is unaffected.
  expect(userEvents.send("alice", "ghost")).toEqual(0);
  expect(userEvents.send("bob", "still here")).toEqual(1);
  expect(await readEventFrame(bobReader)).toEqual("data: still here\n\n");

  bobAbort.abort();
  await waitFor(() => userEvents.count() === 0, "all clients deregistered");

  userEvents.closeAll();
  await server.stop(true);
});
