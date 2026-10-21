import { describe, expect, it } from "bun:test";
import { type DIContainer, r } from "../core/index.ts";
import {
  connect,
  connectRejected,
  handshake,
  startServer,
  useServers,
} from "./_test_utils.ts";
import { withWs } from "./router.ts";
import { bearerFromProtocol, MemoryTicketStore, WsTickets } from "./tickets.ts";

useServers();

class SocketTickets extends WsTickets<{ userId: string }> {}

describe("WsTickets", () => {
  it("issues 43-char base64url tickets that redeem to the payload", async () => {
    const tickets = new SocketTickets();
    const ticket = await tickets.issue({ userId: "u1" });
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await tickets.redeem(ticket)).toEqual({ userId: "u1" });
  });

  it("tickets are single-use", async () => {
    const tickets = new SocketTickets();
    const ticket = await tickets.issue({ userId: "u1" });
    expect(await tickets.redeem(ticket)).not.toBeNull();
    expect(await tickets.redeem(ticket)).toBeNull();
  });

  it("tickets are unique", async () => {
    const tickets = new SocketTickets();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++)
      seen.add(await tickets.issue({ userId: "u" }));
    expect(seen.size).toEqual(200);
  });

  it("expired tickets are rejected", async () => {
    let now = 1_000;
    const tickets = new SocketTickets({
      ttlMs: 30_000,
      store: new MemoryTicketStore({ now: () => now }),
    });
    const ticket = await tickets.issue({ userId: "u1" });
    now += 30_000;
    expect(await tickets.redeem(ticket)).toBeNull();
  });

  it.each([null, undefined, "", "short", `${"a".repeat(42)}!`, "a".repeat(44)])(
    "malformed ticket %p never touches the store",
    async (bad) => {
      let lookups = 0;
      const tickets = new SocketTickets({
        store: {
          set() {},
          take() {
            lookups++;
            return null;
          },
        },
      });
      expect(await tickets.redeem(bad)).toBeNull();
      expect(lookups).toEqual(0);
    },
  );

  it("fingerprinted tickets only redeem for a matching request, and are consumed on mismatch", async () => {
    const tickets = new SocketTickets({
      fingerprint: (req) => req.headers.get("user-agent") ?? "",
    });
    const ua = (agent: string) =>
      new Request("http://l/", { headers: { "user-agent": agent } });

    const ticket = await tickets.issue({ userId: "u1" }, ua("browser-a"));
    expect(await tickets.redeem(ticket, ua("browser-b"))).toBeNull();
    expect(await tickets.redeem(ticket, ua("browser-a"))).toBeNull(); // burned

    const fresh = await tickets.issue({ userId: "u1" }, ua("browser-a"));
    expect(await tickets.redeem(fresh, ua("browser-a"))).toEqual({
      userId: "u1",
    });
  });

  it("fingerprinting requires the issuing request", async () => {
    const tickets = new SocketTickets({ fingerprint: () => "x" });
    await expect(tickets.issue({ userId: "u" })).rejects.toThrow(
      /requires the request/,
    );
  });

  it("supports async stores (e.g. Redis)", async () => {
    const map = new Map<string, string>();
    const tickets = new SocketTickets({
      store: {
        async set(id, value) {
          map.set(id, value);
        },
        async take(id) {
          const v = map.get(id);
          map.delete(id);
          return v;
        },
      },
    });
    const ticket = await tickets.issue({ userId: "async" });
    expect(await tickets.redeem(ticket)).toEqual({ userId: "async" });
  });
});

describe("MemoryTicketStore", () => {
  it("caps outstanding tickets, sweeping expired ones first", () => {
    let now = 0;
    const store = new MemoryTicketStore({ maxSize: 2, now: () => now });
    store.set("a", "1", 10);
    store.set("b", "2", 10);
    expect(() => store.set("c", "3", 10)).toThrow(/Too many/);

    now = 20; // both expired → swept
    store.set("c", "3", 10);
    expect(store.size).toEqual(1);
  });
});

describe("ticket middleware", () => {
  function app(tickets: SocketTickets) {
    const api = withWs(r());
    api
      .ws("/live")
      .with(tickets.middleware())
      .handle(({ socket, ctx }) => {
        socket.send(ctx.ticket.userId);
      });
    return api;
  }

  it("rejects handshakes without a valid ticket with 401", async () => {
    const api = app(new SocketTickets());
    api.build();
    expect((await api.fetch(handshake("/live"))).status).toEqual(401);
    expect(
      (await api.fetch(handshake(`/live?ticket=${"a".repeat(43)}`))).status,
    ).toEqual(401);
  });

  it("end-to-end: ticket → socket with ctx.ticket; replay is rejected", async () => {
    const tickets = new SocketTickets();
    const { url } = startServer(app(tickets));

    const ticket = await tickets.issue({ userId: "alice" });
    const client = await connect(url(`/live?ticket=${ticket}`));
    expect(await client.nextText()).toEqual("alice");
    await client.close();

    expect(await connectRejected(url(`/live?ticket=${ticket}`))).toEqual(
      "rejected",
    );
  });

  it("static middleware() resolves the instance from the DI container", async () => {
    const tickets = new SocketTickets();
    const container = {
      get: (token: unknown) => {
        if (token === SocketTickets) return tickets;
        throw new Error("unknown");
      },
    } as DIContainer;
    const api = withWs(r());
    api
      .ws("/live")
      .with(SocketTickets.middleware())
      .handle(({ socket, ctx }) => {
        socket.send(ctx.ticket.userId);
      });
    const { url } = startServer(api, { container });

    const ticket = await tickets.issue({ userId: "di" });
    const client = await connect(url(`/live?ticket=${ticket}`));
    expect(await client.nextText()).toEqual("di");
    await client.close();
  });

  it("a custom query param name is honoured", async () => {
    const tickets = new SocketTickets({ param: "t" });
    const api = app(tickets);
    api.build();
    const ticket = await tickets.issue({ userId: "u" });
    expect(
      (await api.fetch(handshake(`/live?ticket=${ticket}`))).status,
    ).toEqual(401);
    const again = await tickets.issue({ userId: "u" });
    expect((await api.fetch(handshake(`/live?t=${again}`))).status).toEqual(
      426,
    );
  });
});

describe("bearerFromProtocol", () => {
  function app() {
    const api = withWs(r());
    api
      .ws("/ws")
      .protocols(["bearer"])
      .with(bearerFromProtocol())
      .handle(({ socket, ctx }) => {
        socket.send(ctx.bearerToken);
      });
    return api;
  }

  it("reads the token and never echoes it back", async () => {
    const { url } = startServer(app());
    const client = await connect(url("/ws"), ["bearer", "tok.en-123"]);
    expect(client.ws.protocol).toEqual("bearer");
    expect(await client.nextText()).toEqual("tok.en-123");
    await client.close();
  });

  it.each([
    [undefined],
    ["bearer"],
    ["tok.en, bearer"], // token first could be echoed → rejected
    ["bearer, a, b"],
    ["other, tok"],
  ])("rejects Sec-WebSocket-Protocol %p", async (header) => {
    const api = app();
    api.build();
    const res = await api.fetch(
      handshake("/ws", header ? { "sec-websocket-protocol": header } : {}),
    );
    expect([400, 401]).toContain(res.status);
  });
});
