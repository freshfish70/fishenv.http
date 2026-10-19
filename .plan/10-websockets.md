# 10 — WebSocket Support (`@fishenv/http/ws`)

> Supersedes the original Deno-era draft of this step. The project now targets
> Bun, whose WebSocket model differs fundamentally from `Deno.upgradeWebSocket`
> (see §2), so the dispatch design below is new.

## 0. Resolved decisions

| Topic                 | Decision                                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Origin policy         | Inherit the root router's `cors()` origins when set, else same-origin. **Extensible**: `withWs()` and `.origin()` *add* sources (strings, wildcards, RegExp, fns). See §6.1 |
| Channel name syntax   | Reuse the router's path syntax and matcher (`rooms/:roomId`)                                                                                                       |
| Rate limiting         | **Opt-in** (`.rateLimit()`)                                                                                                                                       |
| Transport type        | **Shared** generic `Transport<M>` in core, used by both SSE and WS hubs                                                                                           |
| Contracts             | **Contract-first** WS: `c.ws()` / `c.channel()` in `@fishenv/http/contract`, consumed by the server and by typed clients. See §8.4                                 |
| Presence              | **v1**, in the channel protocol and contracts, so clients can target it. See §8.5                                                                                  |
| Messages (was Q29)    | Superseded: Bun delivers `string \| Buffer`, wrapped in a lazy `WsMessage`                                                                                         |
| Client package        | `ws-client` works in browsers **and** Bun/Node, using only the standard WHATWG `WebSocket` (no `ws` npm dependency)                                             |
| Reconnect semantics   | v1 = **rejoin only** (the app returns history in the `join` reply). Server events carry a reserved, optional `seq` field for future replay                      |
| Channel errors        | **Reuse the HTTP error classes** in contracts (`join(…, errors)`, `clientEvent(…, errors)`), consistent with `.output()`. See §8.4 "Errors"           |

## 1. Goals

- **Zero-plumbing sockets.** An author writes `api.ws("/path").with(auth).handle(...)`
  and gets routing, path-param validation, middleware-based auth, origin
  checks, size/rate limits, heartbeats and backpressure handling for free.
- **Secure by default.** Every limit has a conservative default; loosening one
  is an explicit, visible call in the route chain.
- **Layered, not imposed.** Channels/rooms are an opt-in handler built on
  public primitives. Anyone can skip them and write a raw handler, or build
  their own protocol on the same primitives.
- **Same feel as the rest of the library.** Mirrors `sse/`: a route builder
  that delegates to the core `RouteBuilder`, a `withWs()` mixin, a keyed hub
  that subclasses into a DI token, and a transport seam for multi-instance fan-out.

### Non-goals (v1)

- Socket.IO / Phoenix wire compatibility.
- Long-polling fallback.
- Shipping the client package in the same step. The typed
  `@fishenv/http/ws-client` follows right after (§12, step 9). Contracts and the
  wire protocol are designed for it now.
- AsyncAPI generation (route `meta` is recorded so it can be added later).

### Terminology

| Term          | Meaning in this package                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Namespace** | A WebSocket **route** (`api.ws("/chat")`). Separate path, separate middleware, separate auth. No extra concept needed.        |
| **Room**      | A **server-side** grouping. Server code puts a socket in a room (`hub.join(socket, "team:7")`); the client cannot ask for it. |
| **Channel**   | A **client-requested** topic subscription with an authorization step (`join`), typed inbound events and replies (Layer 3).    |
| **Listener**  | A handler for one inbound event name on a channel or on the socket.                                                           |

---

## 2. Research: Bun constraints that shape the design

1. **Upgrade needs the `Server` object.** `server.upgrade(req, { data, headers })`
   is called from inside `fetch(req, server)` and the fetch must then return
   `undefined`. Our `Router.fetch(req)` doesn't receive `server`.
2. **Status 101 can't be constructed.** `new Response(null, { status: 101 })`
   throws, so a ws route can't just "return the upgrade response".
3. **Response identity isn't preserved.** `cors.applyTo()` and the HEAD branch
   in `Router.fetch` build new `Response` objects, so a marker property on the
   response would be lost.
4. **One `websocket` handler per server.** `open/message/close/drain` are
   server-global. Per-route behaviour has to be dispatched through `ws.data`.
5. **Socket options are server-global too.** `maxPayloadLength`, `idleTimeout`,
   `backpressureLimit`, `perMessageDeflate` are set once on `Bun.serve`.
   Per-route limits that are *stricter* have to be enforced in our dispatch.
6. **Bun's defaults are permissive:** 16 MB max payload, 16 MB backpressure
   buffer, `closeOnBackpressureLimit: false`. We override them (§3).
7. **Native pub/sub.** `ws.subscribe(topic)`, `ws.publish()`, `server.publish()`
   fan out in native code without JS loops. Topics are process-local and
   server-wide, so we namespace them to avoid collisions between hubs and routes.
8. **`send()` reports backpressure.** It returns `-1` (queued, backpressured),
   `0` (dropped) or the byte count. `drain` fires when the buffer empties.
9. **Async `open` doesn't hold back `message`.** If `open` awaits (e.g. a DB
   lookup), `message` can fire before setup finishes. We need to queue inbound messages until `open` settles.
10. **No `MessageEvent` server-side.** Messages arrive as `string | Buffer`.
    This replaces decision Q29 ("expose `MessageEvent` as-is"), which assumed Deno.
11. **(Found during implementation)** Frames above the *server-wide*
    `maxPayloadLength` are dropped by Bun without a close frame, so clients
    see `1006`, not `1009`. Per-route `.maxMessageSize()` is enforced in our
    lifecycle and does send a real `1009`.
12. **(Found during implementation)** If the server doesn't set
    `Sec-WebSocket-Protocol`, Bun **echoes the client's first offered
    subprotocol** (and an empty header just produces a duplicate). Routes
    without `.protocols()` therefore look as if they accept anything the client
    offers, and `socket.protocol` stays `null`. Anything that relies on
    subprotocols (channels, `bearerFromProtocol`) must negotiate explicitly.
13. **Guards before router middleware.** Router-level middleware runs before
    route middleware, so the origin check uses a core `guards` hook on the
    route definition. Root `cors()` inheritance and build-time warnings use an
    `onBuild(env)` hook, because ws routes may live on mounted child routers.

---

## 3. Threat model & secure defaults

| Threat                                      | Mitigation                                                                                                                                                                                                                                                                                       | Default                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Cross-Site WebSocket Hijacking (CSWSH)**: browsers send cookies on cross-origin WS handshakes and CORS doesn't apply | `Origin` check runs **before** middleware. Allow-list via `.origin([...])`, a fn, or inherit the root router's `cors()` origins.                                                                                                                                                                 | Root `cors()` origins if configured (**except `"*"`**, see §6.1), else **same-origin** (`Origin` host must equal `Host`). Requests with no `Origin` (non-browser clients) are allowed: they can't carry ambient browser credentials. |
| Unauthenticated connections                 | Router/route middleware runs before the upgrade; a thrown `HttpError` becomes a normal HTTP error response and **no socket is opened**.                                                                                                                                                          | Middleware chain is mandatory-path (same as HTTP)          |
| Credentials in URLs (logs, proxies, history) | Browsers can't set `Authorization` on WS. Ship `WsTickets`: short-lived, **single-use** tickets minted by an authenticated HTTP call, consumed in middleware. Document cookie + origin check as the alternative.                                                                                     | Ticket TTL 30 s, single use                                 |
| Long-lived sessions outliving auth          | `socket.expireAt(date)` closes with `4001 session expired` when the token or session expires. Hubs can `close(key)` on logout or permission revocation.                                                                                                                                        | Off; documented as recommended                              |
| Authorization only at connect time          | Channels have a mandatory `join` authorizer: being connected never implies access to a room or topic.                                                                                                                                                                                             | Channel without `.join()` → **startup error**               |
| Oversized frames / memory exhaustion        | Global `maxPayloadLength` + per-route `.maxMessageSize()` (close `1009`).                                                                                                                                                                                                                        | **64 KiB**                                                  |
| Message flooding                            | Per-connection token bucket `.rateLimit({ messages, perMs, onExceed })`.                                                                                                                                                                                                                         | **Opt-in**. Docs recommend it for any public endpoint. `onExceed: "close"` → `1008` |
| Slow consumers / unbounded send buffers     | `backpressureLimit` + `closeOnBackpressureLimit`. `send()` returns a typed result. Hub broadcasts skip saturated sockets.                                                                                                                                                                        | **1 MiB**, close on limit                                   |
| Connection exhaustion                       | `.maxConnections({ total, perKey })`: rejected **before** upgrade with `503` or `429`.                                                                                                                                                                                                           | total: unlimited, perKey: unlimited (opt-in; key needs ctx) |
| Dead / half-open sockets                    | Bun's native pings + `idleTimeout`.                                                                                                                                                                                                                                                              | `sendPings: true`, idle 120 s                               |
| Decompression bombs / compression side-channels (CRIME-style) | `permessage-deflate` off unless explicitly enabled at `serve()`.                                                                                                                                                                                                                                | **Off**                                                     |
| Malformed / hostile payloads                | Channel layer: JSON parse inside try/catch, envelope validated, every event payload validated with its valibot schema before it reaches the handler. Unknown events are rejected.                                                                                                                | Strict                                                      |
| Prototype pollution via JSON                | Envelope parsing reads only known keys. Payloads are only passed on after schema validation.                                                                                                                                                                                                      | Strict                                                      |
| Error detail leakage                        | Handler throws → close `1011` with a generic reason. `HttpError`s map to app close codes / channel error replies with their public message only. Stack traces only when `serve({ development: true })`.                                                                                          | Generic                                                     |
| Subscription explosion                      | `maxChannelsPerSocket` on the channel handler.                                                                                                                                                                                                                                                   | 32                                                          |
| Topic injection (client-chosen topic strings) | Channel names are matched against declared patterns. Params are validated with `.param()` schemas. Raw client strings never reach `ws.subscribe()`; native topics are namespaced `fx:<hubId>:<key>`.                                                                                           | Strict                                                      |
| Cleartext transport                         | Out of scope for the framework (TLS terminates at Bun `tls` or the proxy). Docs note `wss://` only in production.                                                                                                                                                                                 | n/a                                                         |

### Close codes used

| Code | When                                                       |
| ---- | ---------------------------------------------------------- |
| 1000 | Normal close (`socket.close()`)                            |
| 1001 | Server shutting down (`hub.closeAll()`, server stop)       |
| 1008 | Policy violation (rate limit, protocol violation)          |
| 1009 | Message too big                                            |
| 1011 | Unhandled handler error                                    |
| 1013 | Try again later (backpressure close)                       |
| 4001 | Session expired (`expireAt`)                               |
| 4003 | Forbidden (`ForbiddenError` thrown after open)             |
| 4xxx | `HttpError` thrown after open → `4000 + status` (e.g. 4401, 4403, 4422) |

---

## 4. Architecture: four layers

```
┌───────────────────────────────────────────────────────────────┐
│ L3  channels()      opt-in protocol: join/leave/events/acks   │  ws/channels/*
├───────────────────────────────────────────────────────────────┤
│ L2  utilities       WsHub (keys + rooms), codecs, WsTickets,  │  ws/hub.ts, ws/codec.ts,
│                     transport seam                            │  ws/tickets.ts
├───────────────────────────────────────────────────────────────┤
│ L1  .ws() route     WsConnection, lifecycle handle(), limits, │  ws/route-builder.ts,
│                     origin check, protocols                   │  ws/connection.ts
├───────────────────────────────────────────────────────────────┤
│ L0  core upgrade    generic upgrade side-channel + Bun        │  core/upgrade.ts,
│                     websocket dispatcher in serve()           │  core/router.ts
└───────────────────────────────────────────────────────────────┘
```

Each layer only uses the public API of the layer below, which is how
"build your own handler" is guaranteed rather than just promised.

---

## 5. Layer 0: core changes (small, WS-agnostic)

Core must not import from `ws/`. It gets a tiny generic upgrade mechanism.

```ts
// core/upgrade.ts
export interface SocketHandlers {
  open?(ws: ServerWebSocket<SocketData>): void | Promise<void>;
  message?(ws: ServerWebSocket<SocketData>, msg: string | Buffer): void | Promise<void>;
  close?(ws: ServerWebSocket<SocketData>, code: number, reason: string): void | Promise<void>;
  drain?(ws: ServerWebSocket<SocketData>): void;
}
export interface SocketData { handlers: SocketHandlers; state: unknown }

export interface UpgradeIntent {
  handlers: SocketHandlers;
  state: unknown;
  headers?: HeadersInit; // e.g. Sec-WebSocket-Protocol
}

/** Survives Response cloning (CORS, HEAD) because it's keyed by Request. */
const pending = new WeakMap<Request, UpgradeIntent>();

/** Called by a route handler. Returns a placeholder Response that serve() discards. */
export function requestUpgrade(req: Request, intent: UpgradeIntent): Response;
/** @internal used by serve() */
export function takeUpgrade(req: Request): UpgradeIntent | undefined;
/** @internal the single Bun `websocket` object that dispatches via ws.data.handlers */
export const websocketDispatcher: WebSocketHandler<SocketData>;
```

`serve()` changes:

```ts
const server = Bun.serve({
  ...,
  fetch: async (req, server) => {
    const res = await app.fetch(req);
    const intent = takeUpgrade(req);
    if (intent == null) return res;
    if (server.upgrade(req, { data: { handlers: intent.handlers, state: intent.state }, headers: intent.headers })) {
      return undefined;
    }
    return new Response("WebSocket upgrade failed", { status: 400 });
  },
  websocket: {
    ...websocketDispatcher,
    maxPayloadLength: ws.maxPayloadLength ?? 64 * 1024,
    backpressureLimit: ws.backpressureLimit ?? 1024 * 1024,
    closeOnBackpressureLimit: ws.closeOnBackpressureLimit ?? true,
    idleTimeout: ws.idleTimeout ?? 120,
    sendPings: ws.sendPings ?? true,
    perMessageDeflate: ws.perMessageDeflate ?? false,
  },
});
```

- `ServeOptions.websocket?: WsServerOptions` exposes the global knobs.
- `serve()` also records the `Server` in a module-level registry so hubs can
  call `server.publish()` (see L2). Exposed as `@internal getActiveServer()`.
- If a ws route's per-route `maxMessageSize` exceeds the global
  `maxPayloadLength`, `build()` warns at startup, because the global limit wins.
- `Router.fetch` without `serve()` (unit tests): the placeholder response is
  `426 Upgrade Required`, so tests of the rejection paths (401, 403, origin)
  work through `router.fetch` unchanged.

---

## 6. Layer 1: `.ws()` route + `WsConnection`

### Usage

```ts
import { r, serve } from "@fishenv/http";
import { withWs } from "@fishenv/http/ws";

const api = withWs(r({ prefix: "/api" }).use(auth));

api.ws("/echo/:roomId")
  .param("roomId", v.pipe(v.string(), v.uuid()))
  .with(requireMember)            // runs before upgrade; throw → HTTP 403, no socket
  .origin(["https://app.example.com"])
  .maxMessageSize(16 * 1024)
  .rateLimit({ messages: 20, perMs: 1000 })
  .handle(({ socket, path, ctx }) => {
    socket.onMessage((msg) => socket.send(`[${path.roomId}] ${msg.text()}`));
    return () => console.log("closed");   // optional cleanup, same as SSE
  });
```

### Builder

Delegates to the core `RouteBuilder` (method `GET`, `kind: "ws"`), so
`.param()` / `.with()` / `.meta()` keep identical generics to HTTP and SSE.

| Method                                  | Purpose                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `api.ws(path \| wsContract)`            | Entry point. With a `c.ws()` contract, path, params, protocol and message types come from the contract |
| `.param(name, schema)`                  | Path-param validation (before upgrade). Not available on contract routes, where the contract owns the params |
| `.with(mw)`                             | Route middleware (before upgrade)                                             |
| `.meta(data)`                           | Docs metadata                                                                 |
| `.origin(...sources, opts?)`            | Adds CSWSH allow-list sources (§6.1). `"any"` is the explicit opt-out.        |
| `.protocols(["v1", "v2"])`              | Subprotocol negotiation. Picks the first match, echoes it, rejects `400` if none. |
| `.maxMessageSize(bytes)`                | Per-route inbound limit (≤ global)                                            |
| `.rateLimit({ messages, perMs, onExceed: "close" \| "drop" })` | Inbound token bucket                                   |
| `.maxConnections({ total?, perKey?: { key: (args) => string, max } })` | Checked pre-upgrade                       |
| `.handle(fn)`                           | Terminal: raw lifecycle                                                       |
| `.subscribe(HubToken, keyFn)`           | Terminal shorthand: register in a hub (like SSE)                              |
| `.channels(defs, opts)`                 | Terminal: Layer 3 protocol handler                                            |

Pre-upgrade order: **origin → upgrade-header check (426) → protocols → middleware → params →
connection limits → `requestUpgrade`**. Origin comes first so a hostile page can't
even trigger auth middleware side effects.

### 6.1 Origin policy: inherited and extensible

The effective allow-list for a route is the **union** of three levels, so each
level can extend the one above it:

```
root cors() origins  ∪  withWs(router, { origins })  ∪  route .origin(...)
```

```ts
type OriginSource =
  | "same-origin"                                  // Origin host === Host header
  | "any"                                          // explicit opt-out, logged once at build()
  | string                                         // exact: "https://app.example.com"
  | `${string}://*.${string}`                      // wildcard subdomain: "https://*.example.com"
  | RegExp                                         // anchored automatically
  | ((origin: string, req: Request) => boolean | Promise<boolean>);

const api = withWs(r().cors({ origin: ["https://app.example.com"] }), {
  origins: ["https://admin.example.com"],          // added for every ws route on this router
});

api.ws("/embed")
  .origin("https://*.partner.com", isTenantOrigin) // added on top of the inherited ones
  .handle(...);

api.ws("/internal")
  .origin("same-origin", { inherit: false })       // replace instead of extend
  .handle(...);
```

Rules:

- **`cors({ origin: "*" })` is not inherited.** A wildcard on a cookie-authenticated
  WebSocket would disable CSWSH protection, so it needs an explicit `.origin("any")`.
  `build()` warns when this situation is detected.
- A dynamic `cors({ origin: fn })` is inherited as a function source.
- Wildcards are matched by parsing the URL: scheme and port must match exactly,
  and the host must end with `.example.com` (so `evilexample.com` doesn't match,
  and the bare `example.com` isn't matched by `*.`).
- `"same-origin"` is part of the set only when no other sources exist at any
  level, or when it's listed explicitly.
- Rejection is `403` before upgrade, with no detail on which rule failed.
- Core change: `CompiledCors` exposes `@internal originSources()` so `ws/`
  can read the configured origins without duplicating parsing.
- The resolver lives in `ws/origin.ts` and is exported (`createOriginPolicy()`)
  so custom handlers and other packages can reuse it.

### Handler contract

```ts
type WsHandlerFn<Ctx, Params> = (args: {
  socket: WsConnection;
  path: Params;
  ctx: Ctx;
  req: Request;            // the upgrade request
  container: DIContainer;
}) => void | WsCleanupFn | Promise<void | WsCleanupFn>;
```

- Runs in Bun's `open`. Inbound messages are **buffered** (bounded by the
  rate-limit burst) until the returned promise settles, then replayed in order.
- A throw closes the socket: `HttpError` → `4000+status`, anything else → `1011`.
- The cleanup fn runs exactly once on close, error or server shutdown.

### `WsConnection` (wraps `ServerWebSocket`)

Like `SseConnection`, every method is a safe no-op after close, so stale
references held by services never throw.

```ts
class WsConnection {
  readonly id: string;                 // uuid
  readonly req: Request;
  readonly protocol: string | null;
  readonly remoteAddress: string;
  readonly closed: boolean;
  readonly bufferedBytes: number;
  data: Record<string, unknown>;       // per-connection user state

  send(data: string | ArrayBufferView | ArrayBuffer): WsSendResult; // "sent" | "backpressure" | "dropped" | "closed"
  sendJson(value: unknown): WsSendResult;
  close(code?: number, reason?: string): void;
  expireAt(when: Date | number): void; // auto-close 4001

  onMessage(fn: (msg: WsMessage) => void | Promise<void>): () => void;
  onClose(fn: (code: number, reason: string) => unknown): void;
  onDrain(fn: () => void): () => void;

  /** Escape hatch. Mixing native subscribe() with hubs is allowed but unnamespaced. */
  readonly raw: ServerWebSocket<unknown>;
}

interface WsMessage {
  readonly isBinary: boolean;
  readonly size: number;
  text(): string;          // throws if binary
  bytes(): Uint8Array;
  json<T = unknown>(): T;  // try/catch → ProtocolError → close 1008
}
```

`WsMessage` wraps `string | Buffer` lazily, so binary and text both work
without forcing a decode.

---

## 7. Layer 2: utilities (usable with or without channels)

### 7.1 `WsHub`: keyed registry + rooms

Same shape as `SseHub`, so services push to users the same way regardless of transport.

```ts
class ChatSockets extends WsHub {}            // DI token

api.ws("/live").with(auth).subscribe(ChatSockets, ({ ctx }) => ctx.user.id);

// anywhere (use case, job, webhook):
chatSockets.send(userId, { type: "notification", ... });   // all of a user's tabs
chatSockets.join(socket, "team:7");                        // server-side room
chatSockets.to("team:7").send({ ... });                    // room fan-out
chatSockets.to("team:7").except(socket).send({ ... });
chatSockets.broadcast({ ... });
chatSockets.close(userId, 4401, "logged out");             // revoke on logout
chatSockets.count("team:7");
```

- **Keys** (identity: user, tenant, device) vs **rooms** (membership). One
  socket has one key and many rooms.
- Room fan-out uses Bun native topics (`fx:<hubId>:r:<room>`) via
  `server.publish()` for O(1) JS work per broadcast. If no server is active
  (unit tests), it falls back to iterating the in-memory set.
- `except(socket)` uses `socket.raw.publish()` (which excludes the sender) when there's
  a single exclusion, and iterates otherwise.
- Membership is cleaned up automatically on close.
- Optional `transport` for Redis/NATS/PG fan-out across instances. The type
  is **shared** with SSE: a generic `Transport<M>` moves to `core/transport.ts`
  (exported from `@fishenv/http`), alongside a reusable `createTransportBridge()`
  that handles the node id, echo suppression and publish error logging that
  `SseHub` currently does inline. `SseTransport` becomes
  `Transport<SseTransportMessage>` (kept as an alias, so it's non-breaking), and
  `SseHub` is refactored onto the bridge. One Redis adapter then serves both packages.

  ```ts
  // core/transport.ts
  export interface TransportEnvelope { origin: string }
  export interface Transport<M extends TransportEnvelope = TransportEnvelope & Record<string, unknown>> {
    publish(message: M): void | Promise<void>;
    subscribe(onMessage: (message: M) => void): () => void;
  }
  ```

  WS envelopes are a discriminated union (`send` | `room` | `channel` | `close` |
  `presence`), so one transport instance can be shared by every WS hub.

### 7.2 Codecs

```ts
interface WsCodec<T> { encode(value: T): string | Uint8Array; decode(msg: WsMessage): T }
export const jsonCodec: WsCodec<unknown>;
```

Used by `sendJson` / hubs / channels. Pluggable for MessagePack or CBOR
without touching the channel layer.

### 7.3 `WsTickets`: browser-safe handshake auth

```ts
class SocketTickets extends WsTickets<{ userId: string }> {}

// 1. Authenticated HTTP route mints a ticket
api.post("/ws-ticket").with(auth).handle(({ ctx, container }) =>
  ({ ticket: container.get(SocketTickets).issue({ userId: ctx.user.id }) }));

// 2. Client: new WebSocket(`wss://host/api/live?ticket=${ticket}`)

// 3. WS route consumes it: a middleware factory that throws UnauthorizedError if invalid/used/expired
api.ws("/live").with(SocketTickets.middleware()).handle(({ ctx }) => ctx.ticket.userId);
```

- 32-byte random id, constant-time lookup, single-use (deleted on consume),
  TTL default 30 s, in-memory store with a pluggable `TicketStore` interface
  for multi-instance (Redis `GETDEL`).
- Optional binding to client IP / `User-Agent` to reduce replay value.

### 7.4 Small helpers

- `bearerFromProtocol()` middleware: reads a token from `Sec-WebSocket-Protocol`
  (the `["bearer", token]` convention) and makes sure the token isn't echoed
  back. Documented as a less preferred option than tickets.
- `isWebSocketUpgrade(req)`: header checks (`Upgrade`, `Connection`, `Sec-WebSocket-Version: 13`).

---

## 8. Layer 3: `channels()`, the opt-in protocol handler

Phoenix-Channels-inspired: the client multiplexes many authorized topics over
one socket, each with typed events and request/reply.

### 8.1 Wire protocol `fishenv.channels.v1` (JSON text frames)

```jsonc
// client → server
{ "t": "join",  "ref": 1, "ch": "rooms/42", "d": { "lastSeen": 10 } }
{ "t": "event", "ref": 2, "ch": "rooms/42", "ev": "message", "d": { "text": "hi" } }   // ref optional → no reply
{ "t": "leave", "ref": 3, "ch": "rooms/42" }

// server → client
{ "t": "reply", "ref": 1, "ok": true,  "d": { "history": [] } }
{ "t": "reply", "ref": 2, "ok": false, "err": { "code": "forbidden", "message": "…" } }
{ "t": "event", "ch": "rooms/42", "ev": "message", "d": { "from": "u1", "text": "hi" } }
// "seq" is RESERVED for future replay support: v1 servers never send it, and v1 clients must ignore it
{ "t": "close", "ch": "rooms/42", "reason": "kicked" }        // server-initiated leave

// presence (§8.5), only on channels that declare it
{ "t": "presence_state", "ch": "rooms/42", "d": { "u1": [{ "ref": "c9", "meta": { "status": "online" } }] } }
{ "t": "presence_diff",  "ch": "rooms/42", "joins": { "u2": [{ "ref": "c4", "meta": {} }] }, "leaves": {} }

// client → server presence update (only if the channel allows client updates)
{ "t": "presence_update", "ref": 4, "ch": "rooms/42", "d": { "status": "away" } }
```

- Subprotocol `fishenv.channels.v1` negotiated automatically.
- Anything that doesn't parse or validate gets an error reply if it has a `ref`.
  Repeated violations (default 10) close the socket with `1008`.

### 8.2 Defining channels

Channel names use the same `:param` pattern syntax and matcher as HTTP routes,
so authors learn one syntax and params go through the same valibot coercion.

```ts
import { channel } from "@fishenv/http/ws";

const room = channel<AppCtx>("rooms/:roomId")
  .param("roomId", v.pipe(v.string(), v.uuid()))
  .join(v.object({ lastSeen: v.optional(v.number()) }), async ({ ctx, path, data, container }) => {
    if (!(await container.get(Rooms).isMember(path.roomId, ctx.user.id))) throw new ForbiddenError();
    return { history: await container.get(Messages).since(path.roomId, data.lastSeen) }; // join reply
  })
  .on("message", v.object({ text: v.pipe(v.string(), v.maxLength(2000)) }),
    async ({ data, ctx, path, channel, container }) => {
      const msg = await container.get(Messages).add(path.roomId, ctx.user.id, data.text);
      channel.broadcast("message", msg);       // everyone in rooms/<id>, incl. sender
      return { id: msg.id };                   // reply, only sent if the client gave a ref
    })
  .on("typing", v.object({}), ({ channel, ctx }) =>
    channel.broadcastFrom("typing", { userId: ctx.user.id })) // excludes sender
  .leave(({ ctx, path }) => { /* presence cleanup */ });

api.ws("/socket")
  .with(SocketTickets.middleware())
  .rateLimit({ messages: 30, perMs: 1000 })
  .channels([room, notifications], { maxChannelsPerSocket: 32, hub: ChatSockets });
```

Semantics:

- **`join` is mandatory.** Defining a channel without one fails at `build()`.
  `channel(...).public()` is the explicit opt-out for unauthenticated topics.
- Re-joining a joined channel → error reply. An event for a channel the socket
  hasn't joined → error reply (`not_joined`). Membership is checked on every inbound event.
- Events not declared via `.on()` → `unknown_event` error, never silently dropped
  into a catch-all (an explicit `.onAny()` exists for proxies or bridges).
- Handlers for one socket run **sequentially** (per-socket queue), so the order
  of join → event → leave is guaranteed. Different sockets run concurrently.
- `HttpError` from a handler → `{ ok: false, err: { code, message } }`.
  Other errors → `internal` with no details (unless `development`).
- `channel.broadcast` goes through the hub → native topic `fx:<hubId>:c:rooms/42`,
  and through the transport if one is configured, so server-side code can also
  `hub.channel("rooms/42").send("message", payload)`.
- Server-side kick: `hub.channel("rooms/42").kick(socketOrKey, "reason")`
  (needed for permission revocation).
- Typed: `ChannelDef` carries its event map, so a later
  `@fishenv/http/ws-client` or contract integration can infer client types
  (`InferChannelEvents<typeof room>`).

### 8.3 Building your own handler instead

Everything `channels()` uses is public:

```ts
api.ws("/game").handle(({ socket, ctx, container }) => {
  const hub = container.get(GameSockets);
  hub.add(ctx.user.id, socket);
  socket.onMessage(async (msg) => {
    const cmd = v.parse(GameCommand, msg.json());   // own protocol, own schemas
    ...
    hub.to(`match:${cmd.matchId}`).send(...);
  });
});
```

Or write a reusable handler factory with the same signature as `channels()`:

```ts
type WsProtocolHandler<Ctx, Params> = (route: WsRouteInfo) => WsHandlerFn<Ctx, Params> & { protocol?: string };
api.ws("/rpc").handleWith(jsonRpc(methods));   // the generic terminal for protocol handlers
```

`.channels(defs, opts)` is literally `.handleWith(channels(defs, opts))`. That's the
proof that third-party protocols (JSON-RPC, GraphQL-WS, CRDT sync) plug in the
same way.

### 8.4 Contract-first WebSockets

Same split as HTTP contracts: the contract is portable data with no server
dependencies (only valibot). The server **implements** it, and clients
**consume** it for full type inference. Contracts are immutable builders
(like `ContractBuilder`) exposing a plain `_definition` snapshot.

#### Defining (in `@fishenv/http/contract`)

```ts
import { c } from "@fishenv/http/contract";

const Message = v.object({ id: v.string(), from: v.string(), text: v.string() });

export const room = c
  .channel("rooms/:roomId")
  .param("roomId", v.pipe(v.string(), v.uuid()))
  .join(v.object({ lastSeen: v.optional(v.number()) }),     // join payload
        v.object({ history: v.array(Message) }),           // join reply
        [ForbiddenError])                                  // documented errors
  .clientEvent("message",                                   // client → server
        v.object({ text: v.pipe(v.string(), v.maxLength(2000)) }),
        v.object({ id: v.string() }))                      // reply (omit = fire-and-forget)
  .clientEvent("typing", v.object({}))
  .serverEvent("message", Message)                          // server → client
  .serverEvent("typing", v.object({ userId: v.string() }))
  .presence(v.object({ status: v.picklist(["online", "away"]) }), { clientUpdates: true });

export const notifications = c
  .channel("users/:userId/notifications")
  .join()                                                   // no payload / reply
  .serverEvent("notification", v.object({ title: v.string(), body: v.string() }));

export const socket = c
  .ws("/socket")                                            // the route + protocol
  .channels(room, notifications);

// Raw (non-channel) sockets can be typed too:
export const ticker = c
  .ws("/ticker/:symbol")
  .param("symbol", v.string())
  .messages({ client: v.object({ subscribe: v.boolean() }), server: Quote });
```

#### Implementing (server)

```ts
import { channel } from "@fishenv/http/ws";
import * as wsContract from "@acme/contract/ws";

const roomImpl = channel(wsContract.room)
  .join(async ({ ctx, path, data, container }) => { ... return { history } })  // data/return typed
  .on("message", async ({ data, channel }) => {
    channel.broadcast("message", msg);  // event name + payload type-checked against serverEvent
    return { id: msg.id };              // reply type-checked
  })
  .on("typing", ({ channel, ctx }) => channel.broadcastFrom("typing", { userId: ctx.user.id }))
  .presence(({ ctx }) => ({ key: ctx.user.id, meta: { status: "online" } }));

api.ws(wsContract.socket)               // path, params and protocol come from the contract
  .with(SocketTickets.middleware())
  .channels([roomImpl, notificationsImpl]);

api.ws(wsContract.ticker).handle(({ socket }) => {
  socket.onMessage(({ data }) => ...); // data: { subscribe: boolean }, already validated
  socket.send(quote);                  // typed as Quote
});
```

Guarantees:

- **Completeness, at compile time and at `build()`:** every `clientEvent` needs an
  `.on()` handler, and `.channels([...])` must cover every channel in
  `c.ws().channels(...)`, with no extras. Type errors name the missing event or channel,
  and `build()` re-checks at runtime for JS users.
- **Inbound validation** always uses the contract schemas (join payload,
  client events, presence updates, raw messages).
- **Outbound validation** (server events, replies, presence meta) runs only
  when `serve({ development: true })`, so contract drift shows up in dev with
  no production cost. In production, types alone are the guarantee.
- Inline channels (`channel("rooms/:id").on(name, schema, fn)` from §8.2) remain
  supported for apps without a shared contract. Internally they build an
  anonymous contract, so there is a single code path.
- `ContractShape`-style helpers for consumers: `InferChannel<typeof room>` gives
  `{ params, join: { payload, reply }, clientEvents, serverEvents, presenceMeta }`.
  `InferSocket<typeof socket>` gives the channel map.

#### Errors

Contracts reuse the HTTP error classes (`ForbiddenError`, `ValidationError`, …),
just like `.output(Schema, [errors])`:

```ts
c.channel("rooms/:roomId")
  .join(JoinPayload, JoinReply, [ForbiddenError, NotFoundError])
  .clientEvent("message", MessageIn, MessageAck, [UnprocessableEntityError, TooManyRequestsError]);
```

- **On the wire:** an `HttpError` thrown in a handler becomes
  `{ "t": "reply", "ref", "ok": false, "err": { "status": 403, "code": "forbidden", "message": "…" } }`.
  `code` is derived from the class (the snake_case name without `Error`) or set explicitly.
  `ValidationError` also carries its `fields` issues.
- **Same message policy as HTTP:** only the error's public message is sent, and
  unknown errors become `{ status: 500, code: "internal" }`. Details and
  stack traces are only included with `development: true`.
- **Lists are for documentation and typing, as with HTTP Q23:** the server
  doesn't reject undeclared errors at runtime. The client package uses the declared
  list to rebuild typed errors (`err instanceof ForbiddenError`) from `status`/`code`,
  and falls back to a generic `HttpError` otherwise.
- **After open, outside a reply** (e.g. thrown in a raw `.handle()`), the close code
  is `4000 + status` (§3), so both paths share one mapping.
- **Core change:** `HttpError` gets a stable `code` getter and a
  `toJSON(development)` used by both `toResponse()` and the WS reply encoder,
  so HTTP and WS error bodies never diverge.

#### Consuming (clients)

The contract plus the documented wire protocol is everything a client needs.
v1 ships the server and contracts. The typed client
(`@fishenv/http/ws-client`, step 9) is designed against the contract now, so the
types are proven end-to-end in tests:

```ts
const conn = connect(wsContract.socket, { url, ticket });
const ch = await conn.join(wsContract.room, { roomId }, { lastSeen: 10 }); // reply typed
ch.on("message", (m) => ...);                 // m: Message
await ch.push("message", { text: "hi" });     // returns { id }
ch.presence.onSync((list) => ...);            // typed meta
```

### 8.5 Presence

Presence tracks *who* is in a channel (keyed by user, not by socket), and
streams changes to subscribed clients. It's also how server code finds and
targets clients ("everyone currently viewing doc 7", "is user X online?").

#### Model

- An **entry** is `(key, ref, meta)`: `key` is the app identity (user id), `ref`
  is the connection id, `meta` is contract-typed data. A user with three tabs
  has one key and three refs, so closing one tab doesn't make them "leave".
- **Clients see** `presence_state` (a full snapshot) right after a successful
  join, then `presence_diff` with `{ joins, leaves }`, both grouped by key.
  The client merge is trivial and documented.
- **Diff batching:** diffs are coalesced per channel over a short window
  (default 50 ms) to prevent join/leave storms (for example a deploy reconnecting
  thousands of clients).
- **Limits:** `maxEntriesPerChannel`, meta size checked against the contract
  schema, and client `presence_update` rate-limited (default 1 per second per
  socket, opt-in via `clientUpdates: true` in the contract).

#### Server API

```ts
// inside channel handlers
.presence(({ ctx, data }) => ({ key: ctx.user.id, meta: { status: "online" } })) // tracked on join, untracked on leave/close
channel.presence.update(socket, { status: "away" });

// anywhere, via the hub (DI)
const p = hub.channel("rooms/42").presence;
p.list();                 // { [key]: { ref, meta }[] }, cluster-wide
p.has("user-1");
p.keys();
hub.channel("rooms/42").to("user-1").send("message", msg);   // target by presence key
hub.channel("rooms/42").kick("user-1", "removed");           // untracks + server leave
```

#### Multi-instance correctness (single-writer CRDT)

Every entry is owned by the node that holds its socket, and **only the owner
writes it**. That avoids the merge complexity of Phoenix's ORSWOT while staying
conflict-free:

- Each node keeps `Map<nodeId, Map<channel, entries>>` with a lamport `clock` per node.
- Local changes are published via the shared `Transport` as
  `{ kind: "presence", op: "diff", node, clock, channel, joins, leaves }`.
- **Heartbeat:** each node publishes `{ op: "heartbeat", node, clock }` every
  5 s. A peer that's silent for longer than 15 s (configurable) is considered dead,
  and all its entries are removed with a synthesized `leaves` diff. That handles
  crashed instances without sticky ghosts.
- **Gaps and new nodes:** a clock gap, or an unknown node in a heartbeat, triggers
  `{ op: "sync_request", node }`. The owner replies with a full `sync` of its own
  entries. New nodes request a sync at startup.
- No transport → single-node mode, the same API with no heartbeat.
- `Presence` is its own class (`ws/presence.ts`) usable without channels, e.g.
  `hub.presence("online-users")` for a global "who's online" list on a raw socket.

---

## 9. Lifecycle & shutdown

- `serve().stop()` → hubs `closeAll(1001)`, cleanup fns run, then `server.stop()`.
- `WsConnection.onClose` and handler cleanup are guaranteed exactly once
  (Bun `close` callback, our own `close()`, backpressure close, idle timeout).
- `AbortSignal` passed to `serve()` triggers the same graceful path.

---

## 10. Module layout

```
ws/
  index.ts              public exports + module doc (mirrors sse/index.ts)
  types.ts              shared types, close codes
  connection.ts         WsConnection, TypedWsConnection, WsMessage
  origin.ts             createOriginPolicy(): sources, wildcard matching, cors inheritance
  limits.ts             token bucket, connection counters
  route-builder.ts      WsRouteBuilder (path or contract)
  router.ts             withWs() mixin
  hub.ts                WsHub (keys, rooms, channel views)
  presence.ts           Presence (single-writer replicated state)
  codec.ts              WsCodec, jsonCodec
  tickets.ts            WsTickets, TicketStore
  helpers.ts            isWebSocketUpgrade, bearerFromProtocol
  channels/
    protocol.ts         envelope schema + encode/decode
    channel.ts          channel() implementation builder (from contract or inline)
    handler.ts          channels() protocol handler (per-socket state machine)
  _test_utils.ts        startTestServer(app) → { url, connect(): TestClient }
contract/
  ws.ts                 NEW: c.ws(), c.channel(), WsContractDefinition, InferChannel/InferSocket
core/
  upgrade.ts            NEW: requestUpgrade / takeUpgrade / websocketDispatcher
  transport.ts          NEW: Transport<M>, createTransportBridge() (shared with SSE)
  cors.ts               + @internal originSources()
  error.ts              + HttpError.code, toJSON(development) shared by HTTP + WS
  router.ts             serve(): websocket wiring + ServeOptions.websocket
sse/
  hub.ts, types.ts      refactored onto the shared Transport (SseTransport kept as alias)
```

`package.json` → add the `"./ws"` export. Later: `"./ws-client"`.

---

## 11. Testing strategy

- **Pre-upgrade rejections via `router.fetch`** (no server): origin denied
  → 403, missing upgrade headers → 426, middleware 401, param 400/422,
  connection limit 429/503, protocol mismatch 400.
- **Origin policy** table tests: inheritance from `cors()` (list, fn, `"*"`
  not inherited + warning), `withWs` / route extension, `inherit: false`,
  wildcard edge cases (`evilexample.com`, bare apex, port and scheme mismatch,
  uppercase, trailing dot, `null` origin).
- **Live tests with `Bun.serve({ port: 0 })`** via `_test_utils.ts` and the
  built-in `WebSocket` client: echo, buffered-before-open ordering, cleanup
  exactly once, `1009` on oversize, `1008` on rate limit, backpressure close,
  `expireAt` → 4001, handler throw → 1011 or 4xxx.
- **Hub**: key/room membership, auto-cleanup, native-topic vs fallback path,
  transport echo suppression. A shared fake transport is used by both the SSE and WS suites.
- **Channels**: protocol fuzz cases (non-JSON, wrong types, huge refs,
  `__proto__` keys), join authorization, `not_joined`, `unknown_event`, sequential
  ordering under concurrent sends, kick, `maxChannelsPerSocket`, violation threshold.
- **Contracts**: type tests for completeness errors (missing `.on()`, missing
  or extra channel impl), payload/reply/server-event inference, raw `.messages()`
  typing. Runtime `build()` completeness check. Dev-mode outbound validation
  fires, and it's skipped in production mode.
- **Presence**: multi-tab (one key, many refs), diff batching, snapshot on
  join, `clientUpdates` gating and rate limit. Multi-node tests with an in-memory
  transport across 3 simulated hubs: convergence, node death → synthesized
  leaves, clock gap → sync, late-joining node sync.
- **Tickets**: single-use, expiry, constant-time compare, store interface.
- **Type tests** (like `core/types.test.ts`): ctx/param inference through
  `.with()`/`.param()` into `handle` and channel handlers.

---

## 12. Implementation order

1. **Core:** `core/upgrade.ts` + `serve()` wiring + `ServeOptions.websocket` with safe
   defaults, then `core/transport.ts`, with `SseHub` refactored onto it (SSE tests must stay green).
2. **L1:** `WsConnection` / `WsMessage` + `.ws().handle()`: origin policy (with
   `cors` inheritance), 426, open-buffering, cleanup, error → close codes.
3. **Limits:** `maxMessageSize`, opt-in `rateLimit`, `maxConnections`, `protocols`, `expireAt`.
4. **L2:** `WsHub` (keys, rooms, native topics, transport) + `.subscribe()`, then `WsTickets` + helpers.
5. **Contracts:** `contract/ws.ts` (`c.ws`, `c.channel`, infer helpers) + `api.ws(contract)`
   for raw typed sockets (`.messages()`).
6. **L3:** wire protocol → `channel()` implementation builder (contract and inline) →
   `channels()` handler → `.handleWith()`, plus completeness checks and dev outbound validation.
7. **Presence:** single node first, then the transport replication (heartbeat, sync, node death).
8. **Docs and examples:** `intro.md` section, `examples/websocket/` (raw echo, hub
   notifications, contract-based chat with tickets + presence), `./ws` export,
   `questions.md` update (Q27–Q29 annotated).
9. **Next package:** `@fishenv/http/ws-client`, a typed client built from the
   contract. It runs in browsers and Bun/Node through the standard `WebSocket` only:
   reconnect with backoff + jitter, automatic rejoin (re-sending the join payload),
   presence merge, ack timeouts, typed error reconstruction, `seq` ignored.
   Auth comes through a `ticket: () => Promise<string>` callback, re-invoked on every
   reconnect because tickets are single-use. Tested against the real server in the same repo.

---

## 13. Open questions

None outstanding. Resolved answers are recorded in §0.

---

## Implementation status (2026-10-19, branch `feat/ws`)

Done: steps 1–8. Step 9 (`ws-client`) has not been started. There are 349
WS-related tests across `core/` (upgrade, transport, errors, guards),
`contract/` and `ws/`. Most run against a real `serve()` with the WHATWG `WebSocket`
client. Presence replication is tested deterministically, with injected
timers and a lossy/duplicating transport. A spot mutation check (disabling
the origin check, open-buffering, the channel membership check and join
authorization) fails the expected tests each time.

Deviations and findings:

- **Core hooks.** Two generic additions instead of ws-specific branching:
  `RouteDefinition.guards` (run before *router-level* middleware, which the
  origin check needs) and `onBuild(env)` (root `cors()` options, `development`,
  logger and websocket settings, for routes on mounted children). `serve()`
  calls `app._setEnv()` before `build()`.
- **Bun drops oversized frames silently.** Above the server-wide
  `maxPayloadLength`, clients see `1006`, not `1009`. The per-route
  `maxMessageSize` sends a real `1009`.
- **Bun echoes the first offered subprotocol** when the route doesn't
  negotiate. `bearerFromProtocol()` therefore requires the scheme to be
  offered first, and routes that care must use `.protocols()`.
- **Error lists.** `ErrorTypes` uses `abstract new (...args: any[]) => Error`.
  The HTTP contract's `(new (...args: unknown[]) => Error)[]` rejects the
  built-in HTTP error classes (their constructor parameters are typed), so
  `.output(schema, [ForbiddenError])` doesn't type-check today. It should be
  aligned separately.
- **HTTP error bodies are unchanged** (`{ error }`). `HttpError` gained `code`
  and `toJSON(development)`. WS replies use the full payload; HTTP bodies
  are rendered from the same disclosure policy.
- **Connection limits** are checked before the upgrade and re-checked on
  open. Only real opens are counted, so an aborted handshake can't leak a slot.
- **Channel replies for fire-and-forget events.** If the client sends a
  `ref`, it still gets `{ ok: true }` as an acknowledgement. A failure
  without a `ref` is reported as `{ t: "error" }`.
- **Channel ctx typing.** Use `channel.withContext<Ctx>()` or the
  `.channels((channel) => [...])` callback. Since TS can't partially infer
  generics, `channel<Ctx>(contract)` isn't possible.
- **Presence diffs** are derived on every node from replicated state and fanned
  out to *local* channel members only. Nothing is re-published per diff.
  Clients merge by `ref`, idempotently (a joiner also sees its own join in the
  first diff after `presence_state`).

Open:

- step 9 (`ws-client`)
- an AsyncAPI generator (route `meta` is recorded)
- message replay (the `seq` field is reserved)
