import { describe, expect, expectTypeOf, it } from "bun:test";
import * as v from "valibot";
import { c } from "../contract/index.ts";
import { type DIContainer, r } from "../core/index.ts";
import {
  connect,
  handshake,
  startServer,
  useServers,
  waitFor,
  wsApp,
} from "./_test_utils.ts";
import type { WsConnection } from "./connection.ts";
import { WsHub } from "./hub.ts";
import { withWs } from "./router.ts";
import type { TypedWsConnection } from "./typed.ts";

useServers();

const Quote = v.object({ symbol: v.string(), price: v.number() });
const Subscribe = v.object({
  subscribe: v.boolean(),
  depth: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 1),
});

const ticker = c
  .ws("/ticker/:symbol")
  .param("symbol", v.pipe(v.string(), v.toUpperCase()))
  .messages({ client: Subscribe, server: Quote });

describe("api.ws(contract) — messages sockets", () => {
  it("takes path + params from the contract and types the socket", async () => {
    const app = wsApp();
    app.ws(ticker).handle(({ socket, path }) => {
      expectTypeOf(path.symbol).toEqualTypeOf<string>();
      expectTypeOf(socket).toEqualTypeOf<
        TypedWsConnection<
          { subscribe: boolean; depth: number },
          { symbol: string; price: number }
        >
      >();

      socket.onMessage((msg) => {
        // depth default applied by the schema
        socket.send({
          symbol: path.symbol,
          price: msg.subscribe ? msg.depth : 0,
        });
      });
    });
    const { url } = startServer(app);

    const client = await connect(url("/ticker/aapl"));
    client.sendJson({ subscribe: true });
    expect(await client.nextJson()).toEqual({ symbol: "AAPL", price: 1 });
    client.sendJson({ subscribe: true, depth: 5 });
    expect(await client.nextJson()).toEqual({ symbol: "AAPL", price: 5 });
    await client.close();
  });

  it("off-contract inbound messages close with 1008 before the handler", async () => {
    let calls = 0;
    const app = wsApp();
    app.ws(ticker).handle(({ socket }) => {
      socket.onMessage(() => void calls++);
    });
    const { url } = startServer(app);

    const client = await connect(url("/ticker/x"));
    client.sendJson({ subscribe: "yes" });
    expect(await client.closed).toEqual({
      code: 1008,
      reason: "Invalid message",
    });
    expect(calls).toEqual(0);
  });

  it("development mode names the failing issue in the close reason", async () => {
    const app = wsApp();
    app.ws(ticker).handle(({ socket }) => {
      socket.onMessage(() => {});
    });
    const { url } = startServer(app, { development: true });

    const client = await connect(url("/ticker/x"));
    client.sendJson({ subscribe: true, depth: 0 });
    const closed = await client.closed;
    expect(closed.code).toEqual(1008);
    expect(closed.reason).toStartWith("Invalid message: ");
  });

  it("non-JSON inbound closes with 1008", async () => {
    const app = wsApp();
    app.ws(ticker).handle(({ socket }) => {
      socket.onMessage(() => {});
    });
    const { url } = startServer(app);
    const client = await connect(url("/ticker/x"));
    client.send("{nope");
    expect(await client.closed).toEqual({ code: 1008, reason: "Invalid JSON" });
  });

  it("development mode rejects off-contract outbound messages", async () => {
    const app = wsApp();
    app.ws(ticker).handle(({ socket }) => {
      socket.onMessage(() => {
        socket.send({ symbol: "X", price: "free" } as never);
      });
    });
    const { url } = startServer(app, { development: true });

    const client = await connect(url("/ticker/x"));
    client.sendJson({ subscribe: true });
    const closed = await client.closed;
    expect(closed.code).toEqual(1011);
    expect(closed.reason).toContain("does not match the contract");
    expect(closed.reason).toContain("price");
  });

  it("production mode does not validate outbound messages", async () => {
    const app = wsApp();
    app.ws(ticker).handle(({ socket }) => {
      socket.onMessage(() => {
        socket.send({ symbol: "X", price: "free" } as never);
      });
    });
    const { url } = startServer(app);

    const client = await connect(url("/ticker/x"));
    client.sendJson({ subscribe: true });
    expect(await client.nextJson()).toEqual({ symbol: "X", price: "free" });
    await client.close();
  });

  it("contract param schemas are validated before upgrade", async () => {
    const numeric = c
      .ws("/n/:id")
      .param("id", v.pipe(v.string(), v.regex(/^\d+$/)));
    const app = wsApp();
    app.ws(numeric).handle(() => {});
    app.build();
    expect((await app.fetch(handshake("/n/abc"))).status).toEqual(400);
    expect((await app.fetch(handshake("/n/42"))).status).toEqual(426);
  });

  it("works under router prefixes", async () => {
    const app = withWs(r({ prefix: "/api" }));
    app.ws(ticker).handle(({ socket, path }) => {
      socket.send({ symbol: path.symbol, price: 0 });
    });
    const { url } = startServer(app);
    const client = await connect(url("/api/ticker/abc"));
    expect(await client.nextJson()).toEqual({ symbol: "ABC", price: 0 });
    await client.close();
  });

  it(".subscribe() registers the underlying connection in the hub", async () => {
    class Tickers extends WsHub {}
    const hub = new Tickers();
    const container = { get: () => hub } as unknown as DIContainer;
    const app = wsApp();
    app.ws(ticker).subscribe(Tickers, ({ path }) => path.symbol);
    const { url } = startServer(app, { container });

    const client = await connect(url("/ticker/msft"));
    await waitFor(() => hub.has("MSFT"), "registration");
    hub.send("MSFT", { symbol: "MSFT", price: 1 });
    expect(await client.nextJson()).toEqual({ symbol: "MSFT", price: 1 });
    await client.close();
  });
});

describe("api.ws(contract) — other kinds", () => {
  it("raw contracts give a plain WsConnection and enforce contract protocols", async () => {
    const raw = c.ws("/raw").protocols(["v1"]);
    const app = wsApp();
    app.ws(raw).handle(({ socket }) => {
      expectTypeOf(socket).toEqualTypeOf<WsConnection>();
      socket.send(socket.protocol ?? "none");
    });
    const { url } = startServer(app);

    const client = await connect(url("/raw"), ["v1"]);
    expect(await client.nextText()).toEqual("v1");
    await client.close();

    app.build();
    expect((await app.fetch(handshake("/raw"))).status).toEqual(400);
  });

  it("param() is not allowed on contract routes", () => {
    const app = wsApp();
    expect(() => app.ws(c.ws("/x/:id")).param("id", v.string())).toThrow(
      /come from the contract/,
    );
  });

  it("channel contracts must be implemented with .channels()", () => {
    const socket = c.ws("/s").channels(c.channel("a").join());
    const app = wsApp();
    expect(() => app.ws(socket).handle(() => {})).toThrow(/\.channels/);
  });
});
