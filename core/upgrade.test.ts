import { afterEach, describe, expect, it } from "bun:test";
import { connect, connectRejected, waitFor, wsUrl } from "./_test_utils.ts";
import { UnauthorizedError } from "./error.ts";
import { type HttpServer, r, serve } from "./router.ts";
import {
  completeUpgrade,
  requestUpgrade,
  type SocketHandlers,
  takeUpgrade,
} from "./upgrade.ts";

const servers: HttpServer[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop(true);
});

function start(
  handlers: SocketHandlers,
  opts: Parameters<typeof serve>[1] = {},
  extra?: (app: ReturnType<typeof r>) => void,
) {
  const app = r();
  app
    .get("/ws")
    .handle(({ req }) => requestUpgrade(req, { handlers, state: "s-1" }));
  app.get("/plain").handle(() => new Response("plain"));
  extra?.(app);
  const server = serve(app, { port: 0, hostname: "127.0.0.1", ...opts });
  servers.push(server);
  return server;
}

// ── side channel ───────────────────────────────────────────────────────

describe("requestUpgrade / takeUpgrade", () => {
  it("returns a 426 placeholder advertising websocket", () => {
    const req = new Request("http://localhost/ws");
    const res = requestUpgrade(req, { handlers: {} });
    expect(res.status).toEqual(426);
    expect(res.headers.get("upgrade")).toEqual("websocket");
  });

  it("takeUpgrade returns the intent once", () => {
    const req = new Request("http://localhost/ws");
    const intent = { handlers: {} };
    requestUpgrade(req, intent);
    expect(takeUpgrade(req)).toBe(intent);
    expect(takeUpgrade(req)).toBeUndefined();
  });

  it("intents are scoped to their own Request", () => {
    const a = new Request("http://localhost/ws");
    const b = new Request("http://localhost/ws");
    requestUpgrade(a, { handlers: {} });
    expect(takeUpgrade(b)).toBeUndefined();
  });

  it("router.fetch without a server surfaces the 426 placeholder", async () => {
    const app = r();
    app.get("/ws").handle(({ req }) => requestUpgrade(req, { handlers: {} }));
    app.build();
    const res = await app.fetch(new Request("http://localhost/ws"));
    expect(res.status).toEqual(426);
  });

  it("completeUpgrade passes the response through when nothing is pending", () => {
    const res = new Response("x");
    const fakeServer = {
      upgrade: () => {
        throw new Error("must not upgrade");
      },
    } as never;
    expect(completeUpgrade(new Request("http://l/"), res, fakeServer)).toBe(
      res,
    );
  });

  it("completeUpgrade returns 400 when Bun refuses the upgrade", () => {
    const req = new Request("http://localhost/ws");
    requestUpgrade(req, { handlers: {} });
    const fakeServer = { upgrade: () => false } as never;
    const res = completeUpgrade(req, new Response(), fakeServer);
    expect(res?.status).toEqual(400);
  });
});

// ── serve() integration ────────────────────────────────────────────────

describe("serve() websocket wiring", () => {
  it("dispatches open/message/close to the socket's handlers", async () => {
    const events: string[] = [];
    let seenState: unknown;
    const server = start({
      open(ws) {
        seenState = ws.data.state;
        events.push("open");
      },
      message(ws, msg) {
        events.push(`message:${msg}`);
        ws.send(`echo:${msg}`);
      },
      close(_ws, code) {
        events.push(`close:${code}`);
      },
    });

    const client = await connect(wsUrl(server, "/ws"));
    client.send("hi");
    expect(await client.nextText()).toEqual("echo:hi");
    await client.close(1000);
    await waitFor(() => events.includes("close:1000"), "close event");

    expect(seenState).toEqual("s-1");
    expect(events).toEqual(["open", "message:hi", "close:1000"]);
  });

  it("exposes the owning server on ws.data for native publish", async () => {
    const server = start({
      open(ws) {
        ws.subscribe("room");
        ws.data.server.publish("room", "broadcast");
      },
    });
    const client = await connect(wsUrl(server, "/ws"));
    expect(await client.nextText()).toEqual("broadcast");
    await client.close();
  });

  it("sends intent headers on the handshake (subprotocol)", async () => {
    const app = r();
    app.get("/ws").handle(({ req }) =>
      requestUpgrade(req, {
        handlers: {},
        headers: { "Sec-WebSocket-Protocol": "fishenv.test" },
      }),
    );
    const server = serve(app, { port: 0, hostname: "127.0.0.1" });
    servers.push(server);

    const client = await connect(wsUrl(server, "/ws"), ["fishenv.test"]);
    expect(client.ws.protocol).toEqual("fishenv.test");
    await client.close();
  });

  it("plain HTTP routes are unaffected", async () => {
    const server = start({});
    const res = await fetch(`http://127.0.0.1:${server.port}/plain`);
    expect(await res.text()).toEqual("plain");
  });

  it("a non-upgrade request to an upgrading route gets 400, not a socket", async () => {
    const server = start({});
    const res = await fetch(`http://127.0.0.1:${server.port}/ws`);
    expect(res.status).toEqual(400);
  });

  it("upgrades still work when CORS clones the response", async () => {
    const app = r().cors({ origin: "*" });
    app.get("/ws").handle(({ req }) =>
      requestUpgrade(req, {
        handlers: { open: (ws) => void ws.send("ok") },
      }),
    );
    const server = serve(app, { port: 0, hostname: "127.0.0.1" });
    servers.push(server);

    const client = await connect(wsUrl(server, "/ws"), undefined, {
      headers: { Origin: "https://elsewhere.test" },
    });
    expect(await client.nextText()).toEqual("ok");
    await client.close();
  });

  it("middleware failures reject the handshake before any socket opens", async () => {
    let opened = false;
    const app = r().use(() => {
      throw new UnauthorizedError();
    });
    app.get("/ws").handle(({ req }) =>
      requestUpgrade(req, {
        handlers: {
          open: () => {
            opened = true;
          },
        },
      }),
    );
    const server = serve(app, { port: 0, hostname: "127.0.0.1" });
    servers.push(server);

    expect(await connectRejected(wsUrl(server, "/ws"))).toEqual("rejected");
    expect(opened).toEqual(false);
  });
});

// ── safety net & defaults ──────────────────────────────────────────────

describe("serve() websocket safety", () => {
  it("a throwing handler closes its socket with 1011 and is logged", async () => {
    const logged: unknown[] = [];
    const logger = {
      error: (...args: unknown[]) => void logged.push(args),
      warn() {},
      info() {},
    };
    const server = start(
      {
        message() {
          throw new Error("boom");
        },
      },
      { logger },
    );
    const client = await connect(wsUrl(server, "/ws"));
    client.send("x");
    expect((await client.closed).code).toEqual(1011);
    expect(logged).toHaveLength(1);
  });

  it("a rejecting async handler closes its socket with 1011", async () => {
    const server = start(
      {
        async message() {
          throw new Error("async boom");
        },
      },
      { logger: { error() {}, warn() {}, info() {} } },
    );
    const client = await connect(wsUrl(server, "/ws"));
    client.send("x");
    expect((await client.closed).code).toEqual(1011);
  });

  it("rejects frames above the 64 KiB default with 1009", async () => {
    let received = 0;
    const server = start({ message: () => void received++ });
    const client = await connect(wsUrl(server, "/ws"));
    client.send("a".repeat(64 * 1024 + 1));
    // Bun drops oversized frames at the protocol layer without a close
    // frame, so clients observe 1006 rather than 1009.
    expect([1006, 1009]).toContain((await client.closed).code);
    expect(received).toEqual(0);
  });

  it("accepts frames at exactly the limit", async () => {
    const server = start({
      message: (ws, msg) => void ws.send(`${msg.length}`),
    });
    const client = await connect(wsUrl(server, "/ws"));
    client.send("a".repeat(64 * 1024));
    expect(await client.nextText()).toEqual(String(64 * 1024));
    await client.close();
  });

  it("maxPayloadLength is configurable", async () => {
    const server = start({}, { websocket: { maxPayloadLength: 8 } });
    const client = await connect(wsUrl(server, "/ws"));
    client.send("123456789");
    expect([1006, 1009]).toContain((await client.closed).code);
  });

  it("stop() closes open sockets with 1001 Going Away", async () => {
    const server = start({});
    const client = await connect(wsUrl(server, "/ws"));
    servers.splice(servers.indexOf(server), 1);
    await server.stop();
    expect((await client.closed).code).toEqual(1001);
  });
});
