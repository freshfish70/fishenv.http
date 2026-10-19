import { describe, expect, it } from "bun:test";
import * as v from "valibot";
import {
  ForbiddenError,
  type MiddlewareFn,
  r,
  UnauthorizedError,
} from "../core/index.ts";
import {
  connect,
  connectRejected,
  handshake,
  silentLogger,
  startServer,
  useServers,
  waitFor,
  wsApp,
} from "./_test_utils.ts";
import { withWs } from "./router.ts";
import { WsCloseError } from "./types.ts";

useServers();

// ── Handshake rejections (router.fetch, no server) ─────────────────────

describe("handshake checks before upgrade", () => {
  it("a valid handshake reaches the upgrade (426 placeholder without a server)", async () => {
    const app = wsApp();
    app.ws("/ws").handle(() => {});
    app.build();
    const res = await app.fetch(handshake("/ws"));
    expect(res.status).toEqual(426);
  });

  it("a plain GET gets 426 with an Upgrade header", async () => {
    const app = wsApp();
    app.ws("/ws").handle(() => {});
    app.build();
    const res = await app.fetch(new Request("http://localhost/ws"));
    expect(res.status).toEqual(426);
    expect(res.headers.get("upgrade")).toEqual("websocket");
  });

  it("other methods get 405 (ws routes are GET only)", async () => {
    const app = wsApp();
    app.ws("/ws").handle(() => {});
    app.build();
    const res = await app.fetch(
      new Request("http://localhost/ws", { method: "POST" }),
    );
    expect(res.status).toEqual(405);
  });

  it("a cross-origin handshake is rejected with 403 by default", async () => {
    const app = wsApp();
    app.ws("/ws").handle(() => {});
    app.build();
    const res = await app.fetch(
      handshake("/ws", { origin: "https://evil.test" }),
    );
    expect(res.status).toEqual(403);
  });

  it("the origin check runs before router-level middleware", async () => {
    let middlewareRan = false;
    const app = withWs(
      r().use(() => {
        middlewareRan = true;
        return {};
      }),
    );
    app.ws("/ws").handle(() => {});
    app.build();
    await app.fetch(handshake("/ws", { origin: "https://evil.test" }));
    expect(middlewareRan).toEqual(false);
  });

  it("same-origin handshakes pass", async () => {
    const app = wsApp();
    app.ws("/ws").handle(() => {});
    app.build();
    const res = await app.fetch(
      handshake("/ws", { origin: "http://localhost" }),
    );
    expect(res.status).toEqual(426);
  });

  it("middleware errors reject the handshake with their HTTP status", async () => {
    const auth: MiddlewareFn<Record<string, unknown>, { user: string }> = ({
      req,
    }) => {
      if (!req.headers.get("x-user")) throw new UnauthorizedError();
      return { user: req.headers.get("x-user")! };
    };
    const app = withWs(r().use(auth));
    app.ws("/ws").handle(() => {});
    app.build();
    expect((await app.fetch(handshake("/ws"))).status).toEqual(401);
    expect(
      (await app.fetch(handshake("/ws", { "x-user": "u1" }))).status,
    ).toEqual(426);
  });

  it("path params are validated before upgrade", async () => {
    const app = wsApp();
    app
      .ws("/rooms/:id")
      .param("id", v.pipe(v.string(), v.uuid()))
      .handle(() => {});
    app.build();
    expect((await app.fetch(handshake("/rooms/nope"))).status).toEqual(400);
    expect(
      (await app.fetch(handshake(`/rooms/${crypto.randomUUID()}`))).status,
    ).toEqual(426);
  });

  it("unsupported subprotocols get 400", async () => {
    const app = wsApp();
    app
      .ws("/ws")
      .protocols(["v2", "v1"])
      .handle(() => {});
    app.build();
    expect(
      (await app.fetch(handshake("/ws", { "sec-websocket-protocol": "v3" })))
        .status,
    ).toEqual(400);
    expect((await app.fetch(handshake("/ws"))).status).toEqual(400);
    expect(
      (await app.fetch(handshake("/ws", { "sec-websocket-protocol": "v1" })))
        .status,
    ).toEqual(426);
  });

  it(".catch() on the route handles pre-upgrade failures", async () => {
    const app = withWs(
      r().use(() => {
        throw new ForbiddenError();
      }),
    );
    app
      .ws("/ws")
      .handle(() => {})
      .catch(() => new Response("custom", { status: 418 }));
    app.build();
    expect((await app.fetch(handshake("/ws"))).status).toEqual(418);
  });

  it("marks the route definition as kind ws", () => {
    const app = wsApp();
    const route = app.ws("/ws").handle(() => {});
    expect(route.definition.kind).toEqual("ws");
    expect(route.definition.method).toEqual("GET");
  });
});

// ── Live sockets ───────────────────────────────────────────────────────

describe("live sockets", () => {
  it("echoes and receives typed ctx/path args", async () => {
    const app = withWs(r().use(() => ({ user: "alice" })));
    app
      .ws("/echo/:room")
      .param("room", v.string())
      .handle(({ socket, path, ctx }) => {
        socket.onMessage((msg) => {
          socket.send(`${ctx.user}@${path.room}: ${msg.text()}`);
        });
      });
    const { url } = startServer(app);

    const client = await connect(url("/echo/lobby"));
    client.send("hi");
    expect(await client.nextText()).toEqual("alice@lobby: hi");
    await client.close();
  });

  it("works on mounted child routers with prefixes and parent middleware", async () => {
    const parent = withWs(r({ prefix: "/api" }).use(() => ({ tenant: "t1" })));
    const child = withWs(r<{ tenant: string }>({ prefix: "/live" }));
    child.ws("/ws").handle(({ socket, ctx }) => {
      socket.send(ctx.tenant);
    });
    parent.add(child);
    const { url } = startServer(parent);

    const client = await connect(url("/api/live/ws"));
    expect(await client.nextText()).toEqual("t1");
    await client.close();
  });

  it("the cleanup fn runs exactly once when the client disconnects", async () => {
    let cleanups = 0;
    const app = wsApp();
    app.ws("/ws").handle(() => () => {
      cleanups++;
    });
    const { url } = startServer(app);

    const client = await connect(url("/ws"));
    await client.close();
    await waitFor(() => cleanups === 1, "cleanup");
    await Bun.sleep(20);
    expect(cleanups).toEqual(1);
  });

  it("the cleanup fn runs when the server closes the socket", async () => {
    let cleanups = 0;
    const app = wsApp();
    app.ws("/ws").handle(({ socket }) => {
      socket.onMessage(() => socket.close(4000, "bye"));
      return () => {
        cleanups++;
      };
    });
    const { url } = startServer(app);

    const client = await connect(url("/ws"));
    client.send("x");
    expect(await client.closed).toEqual({ code: 4000, reason: "bye" });
    await waitFor(() => cleanups === 1, "cleanup");
  });

  it("messages sent during async setup are buffered and delivered in order", async () => {
    const app = wsApp();
    app.ws("/ws").handle(async ({ socket }) => {
      await Bun.sleep(50);
      socket.onMessage((msg) => socket.send(`got:${msg.text()}`));
    });
    const { url } = startServer(app);

    const client = await connect(url("/ws"));
    client.send("1");
    client.send("2");
    client.send("3");
    expect(await client.nextText()).toEqual("got:1");
    expect(await client.nextText()).toEqual("got:2");
    expect(await client.nextText()).toEqual("got:3");
    await client.close();
  });

  it("closes with 1008 when the setup buffer overflows", async () => {
    const app = wsApp();
    app.ws("/ws").handle(() => new Promise(() => {})); // never settles
    const { url } = startServer(app);

    const client = await connect(url("/ws"));
    for (let i = 0; i <= 256; i++) client.send(String(i));
    expect((await client.closed).code).toEqual(1008);
  });

  it("a cleanup returned after the socket already closed still runs", async () => {
    let cleaned = false;
    const app = wsApp();
    app.ws("/ws").handle(async () => {
      await Bun.sleep(80);
      return () => {
        cleaned = true;
      };
    });
    const { url } = startServer(app);

    const client = await connect(url("/ws"));
    await client.close();
    await waitFor(() => cleaned, "late cleanup");
  });

  it("binary frames arrive as binary WsMessages", async () => {
    const app = wsApp();
    app.ws("/ws").handle(({ socket }) => {
      socket.onMessage((msg) => {
        socket.sendJson({ binary: msg.isBinary, bytes: [...msg.bytes()] });
      });
    });
    const { url } = startServer(app);

    const client = await connect(url("/ws"));
    client.send(new Uint8Array([1, 2, 3]));
    expect(await client.nextJson()).toEqual({ binary: true, bytes: [1, 2, 3] });
    await client.close();
  });

  it("send() reports closed after close() and never throws", async () => {
    const results: string[] = [];
    const app = wsApp();
    app.ws("/ws").handle(({ socket }) => {
      results.push(socket.send("first"));
      socket.close();
      results.push(socket.send("after"));
      socket.close(); // idempotent
    });
    const { url } = startServer(app);

    const client = await connect(url("/ws"));
    expect(await client.nextText()).toEqual("first");
    await client.closed;
    expect(results).toEqual(["sent", "closed"]);
  });

  it("onMessage unsubscribe stops delivery", async () => {
    const app = wsApp();
    app.ws("/ws").handle(({ socket }) => {
      const off = socket.onMessage((msg) => {
        socket.send(`once:${msg.text()}`);
        off();
      });
      socket.onMessage((msg) => socket.send(`always:${msg.text()}`));
    });
    const { url } = startServer(app);

    const client = await connect(url("/ws"));
    client.send("a");
    client.send("b");
    const received = [
      await client.nextText(),
      await client.nextText(),
      await client.nextText(),
    ];
    expect(received).toEqual(["once:a", "always:a", "always:b"]);
    await client.close();
  });
});

// ── Errors → close codes ───────────────────────────────────────────────

describe("errors close the socket", () => {
  it("a throwing setup closes with 1011 and is logged", async () => {
    const logger = silentLogger();
    const app = wsApp();
    app.ws("/ws").handle(() => {
      throw new Error("db password=hunter2");
    });
    const { url } = startServer(app, { logger });

    const client = await connect(url("/ws"));
    const closed = await client.closed;
    expect(closed.code).toEqual(1011);
    expect(closed.reason).toEqual("Internal Error"); // no detail leak
    expect(logger.errors).toHaveLength(1);
  });

  it("development mode exposes the message in the close reason", async () => {
    const app = wsApp();
    app.ws("/ws").handle(() => {
      throw new Error("detailed failure");
    });
    const { url } = startServer(app, { development: true });

    const client = await connect(url("/ws"));
    expect((await client.closed).reason).toEqual("detailed failure");
  });

  it("an HttpError closes with 4000 + status and is not logged", async () => {
    const logger = silentLogger();
    const app = wsApp();
    app.ws("/ws").handle(async () => {
      throw new ForbiddenError("Not a member");
    });
    const { url } = startServer(app, { logger });

    const client = await connect(url("/ws"));
    expect(await client.closed).toEqual({ code: 4403, reason: "Not a member" });
    expect(logger.errors).toHaveLength(0);
  });

  it("WsCloseError closes with its own code", async () => {
    const app = wsApp();
    app.ws("/ws").handle(({ socket }) => {
      socket.onMessage(() => {
        throw new WsCloseError(4100, "custom");
      });
    });
    const { url } = startServer(app);

    const client = await connect(url("/ws"));
    client.send("x");
    expect(await client.closed).toEqual({ code: 4100, reason: "custom" });
  });

  it("a rejecting async listener closes with 1011", async () => {
    const app = wsApp();
    app.ws("/ws").handle(({ socket }) => {
      socket.onMessage(async () => {
        throw new Error("async");
      });
    });
    const { url } = startServer(app);

    const client = await connect(url("/ws"));
    client.send("x");
    expect((await client.closed).code).toEqual(1011);
  });

  it("invalid JSON from the client closes with 1008", async () => {
    const app = wsApp();
    app.ws("/ws").handle(({ socket }) => {
      socket.onMessage((msg) => void msg.json());
    });
    const { url } = startServer(app);

    const client = await connect(url("/ws"));
    client.send("{not json");
    expect(await client.closed).toEqual({ code: 1008, reason: "Invalid JSON" });
  });
});

// ── Limits ─────────────────────────────────────────────────────────────

describe("limits", () => {
  it("maxMessageSize closes with a real 1009 frame", async () => {
    let received = 0;
    const app = wsApp();
    app
      .ws("/ws")
      .maxMessageSize(10)
      .handle(({ socket }) => {
        socket.onMessage(() => void received++);
      });
    const { url } = startServer(app);

    const client = await connect(url("/ws"));
    client.send("0123456789"); // exactly 10 bytes: allowed
    client.send("é".repeat(6)); // 12 UTF-8 bytes: too big
    expect((await client.closed).code).toEqual(1009);
    expect(received).toEqual(1);
  });

  it("warns at build when maxMessageSize exceeds the server limit", () => {
    const logger = silentLogger();
    const app = wsApp();
    app
      .ws("/ws")
      .maxMessageSize(1024 * 1024)
      .handle(() => {});
    startServer(app, { logger });
    expect(logger.warnings.some((w) => w.includes("maxMessageSize"))).toEqual(
      true,
    );
  });

  it("rateLimit closes with 1008 once the burst is spent", async () => {
    let received = 0;
    const app = wsApp();
    app
      .ws("/ws")
      .rateLimit({ messages: 3, perMs: 10_000 })
      .handle(({ socket }) => {
        socket.onMessage(() => void received++);
      });
    const { url } = startServer(app);

    const client = await connect(url("/ws"));
    for (let i = 0; i < 5; i++) client.send("x");
    expect(await client.closed).toEqual({
      code: 1008,
      reason: "Rate limit exceeded",
    });
    expect(received).toEqual(3);
  });

  it('rateLimit with onExceed "drop" discards excess but keeps the socket', async () => {
    const app = wsApp();
    app
      .ws("/ws")
      .rateLimit({ messages: 2, perMs: 10_000, onExceed: "drop" })
      .handle(({ socket }) => {
        socket.onMessage((msg) => socket.send(msg.text()));
      });
    const { url } = startServer(app);

    const client = await connect(url("/ws"));
    for (const m of ["a", "b", "c", "d"]) client.send(m);
    expect(await client.nextText()).toEqual("a");
    expect(await client.nextText()).toEqual("b");
    await Bun.sleep(30);
    expect(client.pending).toEqual(0);
    expect(client.ws.readyState).toEqual(WebSocket.OPEN);
    await client.close();
  });

  it("maxConnections.total rejects extra handshakes with 503", async () => {
    const app = wsApp();
    app
      .ws("/ws")
      .maxConnections({ total: 1 })
      .handle(() => {});
    const { url, http } = startServer(app);

    const first = await connect(url("/ws"));
    expect(await connectRejected(url("/ws"))).toEqual("rejected");

    const res = await fetch(http("/ws"), {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    expect(res.status).toEqual(503);

    await first.close();
    await Bun.sleep(20);
    const again = await connect(url("/ws"));
    await again.close();
  });

  it("maxConnections.perKey limits per user and frees slots on close", async () => {
    const app = withWs(
      r().use(({ req }) => ({ user: req.headers.get("x-user") ?? "anon" })),
    );
    app
      .ws("/ws")
      .maxConnections({ perKey: { key: ({ ctx }) => ctx.user, max: 2 } })
      .handle(() => {});
    const { url } = startServer(app);
    const as = (user: string) => ({ headers: { "x-user": user } });

    const a1 = await connect(url("/ws"), undefined, as("alice"));
    const a2 = await connect(url("/ws"), undefined, as("alice"));
    expect(await connectRejected(url("/ws"), undefined, as("alice"))).toEqual(
      "rejected",
    );
    const b1 = await connect(url("/ws"), undefined, as("bob")); // other key unaffected

    await a1.close();
    await Bun.sleep(20);
    const a3 = await connect(url("/ws"), undefined, as("alice"));
    await Promise.all([a2.close(), a3.close(), b1.close()]);
  });

  it("expireAt closes with 4001 Session expired", async () => {
    const app = wsApp();
    app.ws("/ws").handle(({ socket }) => {
      socket.expireAt(Date.now() + 50);
    });
    const { url } = startServer(app);

    const client = await connect(url("/ws"));
    expect(await client.closed).toEqual({
      code: 4001,
      reason: "Session expired",
    });
  });

  it("expireAt in the past closes immediately; re-arming replaces the deadline", async () => {
    const app = wsApp();
    app.ws("/ws").handle(({ socket }) => {
      socket.expireAt(Date.now() + 20);
      socket.expireAt(new Date(Date.now() + 10_000)); // extend
      socket.onMessage(() => socket.expireAt(0));
    });
    const { url } = startServer(app);

    const client = await connect(url("/ws"));
    await Bun.sleep(60);
    expect(client.ws.readyState).toEqual(WebSocket.OPEN);
    client.send("expire");
    expect((await client.closed).code).toEqual(4001);
  });
});

// ── Subprotocols ───────────────────────────────────────────────────────

describe("subprotocols", () => {
  it("picks the server's preferred protocol among those offered", async () => {
    const app = wsApp();
    app
      .ws("/ws")
      .protocols(["v2", "v1"])
      .handle(({ socket }) => {
        socket.send(socket.protocol ?? "none");
      });
    const { url } = startServer(app);

    const client = await connect(url("/ws"), ["v1", "v2"]);
    expect(client.ws.protocol).toEqual("v2");
    expect(await client.nextText()).toEqual("v2");
    await client.close();
  });

  it("documents Bun behaviour: without .protocols() Bun echoes the client's first offer", async () => {
    const app = wsApp();
    app.ws("/ws").handle(({ socket }) => {
      socket.send(String(socket.protocol));
    });
    const { url } = startServer(app);

    const client = await connect(url("/ws"), ["anything"]);
    expect(client.ws.protocol).toEqual("anything");
    expect(await client.nextText()).toEqual("null"); // we did not negotiate
    await client.close();
  });
});

// ── Origin policy end-to-end ───────────────────────────────────────────

describe("origin policy on routes", () => {
  const evil = { headers: { Origin: "https://evil.test" } };
  const app1 = { headers: { Origin: "https://app.test" } };
  const admin = { headers: { Origin: "https://admin.test" } };
  const partner = { headers: { Origin: "https://x.partner.test" } };

  it("rejects cross-origin browsers and allows non-browser clients", async () => {
    const app = wsApp();
    app.ws("/ws").handle(() => {});
    const { url } = startServer(app);

    expect(await connectRejected(url("/ws"), undefined, evil)).toEqual(
      "rejected",
    );
    expect(await connectRejected(url("/ws"))).toEqual("opened");
  });

  it("inherits the root cors() origins", async () => {
    const app = withWs(r().cors({ origin: ["https://app.test"] }));
    app.ws("/ws").handle(() => {});
    const { url } = startServer(app);

    expect(await connectRejected(url("/ws"), undefined, app1)).toEqual(
      "opened",
    );
    expect(await connectRejected(url("/ws"), undefined, evil)).toEqual(
      "rejected",
    );
  });

  it("inherits root cors() even for routes on mounted children", async () => {
    const root = r().cors({ origin: ["https://app.test"] });
    const child = withWs(r({ prefix: "/c" }));
    child.ws("/ws").handle(() => {});
    root.add(child);
    const { url } = startServer(root);

    expect(await connectRejected(url("/c/ws"), undefined, app1)).toEqual(
      "opened",
    );
    expect(await connectRejected(url("/c/ws"), undefined, evil)).toEqual(
      "rejected",
    );
  });

  it("withWs({ origins }) and .origin() extend the inherited list", async () => {
    const app = withWs(r().cors({ origin: ["https://app.test"] }), {
      origins: ["https://admin.test"],
    });
    app
      .ws("/ws")
      .origin("https://*.partner.test")
      .handle(() => {});
    const { url } = startServer(app);

    for (const ok of [app1, admin, partner]) {
      expect(await connectRejected(url("/ws"), undefined, ok)).toEqual(
        "opened",
      );
    }
    expect(await connectRejected(url("/ws"), undefined, evil)).toEqual(
      "rejected",
    );
  });

  it("{ inherit: false } replaces inherited sources", async () => {
    const app = withWs(r().cors({ origin: ["https://app.test"] }), {
      origins: ["https://admin.test"],
    });
    app
      .ws("/ws")
      .origin("https://*.partner.test", { inherit: false })
      .handle(() => {});
    const { url } = startServer(app);

    expect(await connectRejected(url("/ws"), undefined, partner)).toEqual(
      "opened",
    );
    expect(await connectRejected(url("/ws"), undefined, app1)).toEqual(
      "rejected",
    );
    expect(await connectRejected(url("/ws"), undefined, admin)).toEqual(
      "rejected",
    );
  });

  it('cors origin "*" is NOT inherited and triggers a warning', async () => {
    const logger = silentLogger();
    const app = withWs(r().cors({ origin: "*" }));
    app.ws("/ws").handle(() => {});
    const { url } = startServer(app, { logger });

    expect(await connectRejected(url("/ws"), undefined, evil)).toEqual(
      "rejected",
    );
    expect(logger.warnings.some((w) => w.includes("CSWSH"))).toEqual(true);
  });

  it('.origin("any") opts out explicitly and warns', async () => {
    const logger = silentLogger();
    const app = wsApp();
    app
      .ws("/ws")
      .origin("any")
      .handle(() => {});
    const { url } = startServer(app, { logger });

    expect(await connectRejected(url("/ws"), undefined, evil)).toEqual(
      "opened",
    );
    expect(logger.warnings.some((w) => w.includes("disabled"))).toEqual(true);
  });

  it("async predicates work end-to-end", async () => {
    const app = wsApp();
    app
      .ws("/ws")
      .origin(async (origin) => origin === "https://app.test")
      .handle(() => {});
    const { url } = startServer(app);

    expect(await connectRejected(url("/ws"), undefined, app1)).toEqual(
      "opened",
    );
    expect(await connectRejected(url("/ws"), undefined, evil)).toEqual(
      "rejected",
    );
  });

  it("invalid origin sources throw at definition time", () => {
    const app = wsApp();
    expect(() => app.ws("/ws").origin("app.test")).toThrow(/Invalid origin/);
  });
});
