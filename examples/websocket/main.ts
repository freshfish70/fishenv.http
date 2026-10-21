/**
 * WebSockets — three levels, one server
 *
 * - `/api/echo`   raw socket with limits (Layer 1)
 * - `/api/live`   hub-registered socket for server push (Layer 2)
 * - `/api/chat`   contract-based channels with presence (Layer 3),
 *                 authenticated with single-use tickets
 *
 * Run: bun examples/websocket/main.ts
 *
 * Try (bun repl, or any WebSocket client):
 *   const { ticket } = await (await fetch("http://localhost:3005/api/ws-ticket",
 *     { method: "POST", headers: { "x-user": "alice" } })).json();
 *   const ws = new WebSocket(`ws://localhost:3005/api/chat?ticket=${ticket}`,
 *     "fishenv.channels.v1");
 *   ws.onmessage = (e) => console.log(e.data);
 *   ws.send(JSON.stringify({ t: "join", ref: 1, ch: "rooms/lobby", d: {} }));
 *   ws.send(JSON.stringify({ t: "event", ref: 2, ch: "rooms/lobby",
 *     ev: "message", d: { text: "hi" } }));
 */
import {
  type DIContainer,
  ForbiddenError,
  type MiddlewareFn,
  r,
  serve,
  UnauthorizedError,
} from "@fishenv/http";
import { WsHub, WsTickets, withWs } from "@fishenv/http/ws";
import { chatSocket, notifications, room } from "./contract.ts";

// ── Services (registered in a tiny DI container) ───────────────────────

/** Every socket of a user, for server push from anywhere. */
class LiveSockets extends WsHub {}
/** Backs channel membership + presence, so use cases can reach channels. */
class ChatHub extends WsHub {}
class ChatTickets extends WsTickets<{ userId: string }> {}

const services = new Map<unknown, unknown>([
  [LiveSockets, new LiveSockets()],
  [ChatHub, new ChatHub()],
  [ChatTickets, new ChatTickets({ ttlMs: 30_000 })],
]);
const container: DIContainer = {
  get: (token) => services.get(token) as never,
};

// ── Auth (stand-in: trust an x-user header on plain HTTP) ──────────────

const auth: MiddlewareFn<Record<string, unknown>, { userId: string }> = ({
  req,
}) => {
  const userId = req.headers.get("x-user");
  if (!userId) throw new UnauthorizedError();
  return { userId };
};

// ── Routes ─────────────────────────────────────────────────────────────

const api = withWs(r({ prefix: "/api" }));

// Layer 1 — a raw socket. Origin check, 64 KiB frames and 1 MiB send
// buffers are on by default; these add stricter per-route limits.
api
  .ws("/echo")
  .maxMessageSize(4 * 1024)
  .rateLimit({ messages: 20, perMs: 1000 })
  .handle(({ socket }) => {
    socket.onMessage((msg) => socket.send(`echo: ${msg.text()}`));
  });

// Browsers can't send Authorization on a handshake: trade an authenticated
// HTTP call for a short-lived, single-use ticket.
api
  .post("/ws-ticket")
  .with(auth)
  .handle(async ({ ctx, container }) =>
    Response.json({
      ticket: await container.get(ChatTickets).issue({ userId: ctx.userId }),
    }),
  );

// Layer 2 — register every socket of a user for server push.
api
  .ws("/live")
  .with(ChatTickets.middleware())
  .subscribe(LiveSockets, ({ ctx }) => ctx.ticket.userId);

api.post("/notify/:userId").handle(({ path, container }) => {
  const sent = container
    .get(LiveSockets)
    .send(path.userId, { type: "ping", at: Date.now() });
  // Channel push, typed by the contract:
  container
    .get(ChatHub)
    .channel(notifications, `users/${path.userId}/notifications`)
    .send("notification", { title: "You were pinged" });
  return Response.json({ sent });
});

// Layer 3 — implement the channel contract. Missing handlers or channels are
// compile errors (and fail at startup).
const history = new Map<string, { id: string; from: string; text: string }[]>();

api
  .ws(chatSocket)
  .with(ChatTickets.middleware())
  .maxConnections({ perKey: { key: ({ ctx }) => ctx.ticket.userId, max: 5 } })
  .rateLimit({ messages: 30, perMs: 1000 })
  .channels(
    (ch) => [
      ch(room)
        .join(({ path }) => {
          if (path.roomId === "admins") throw new ForbiddenError("Admins only");
          return { history: history.get(path.roomId) ?? [] };
        })
        .presence(({ ctx }) => ({
          key: ctx.ticket.userId,
          meta: { status: "online" },
        }))
        .on("message", ({ data, ctx, path, channel }) => {
          const msg = {
            id: crypto.randomUUID(),
            from: ctx.ticket.userId,
            text: data.text,
          };
          const list = history.get(path.roomId) ?? [];
          history.set(path.roomId, [...list, msg].slice(-50));
          channel.broadcast("message", msg);
          return { id: msg.id };
        })
        .on("typing", ({ ctx, channel }) => {
          channel.broadcastFrom("typing", { userId: ctx.ticket.userId });
        }),

      ch(notifications).join(({ path, ctx }) => {
        if (path.userId !== ctx.ticket.userId) throw new ForbiddenError();
      }),
    ],
    { hub: ChatHub, maxChannelsPerSocket: 10 },
  );

serve(api, {
  port: 3005,
  container,
  onListen: ({ hostname, port }) =>
    console.log(`WebSocket example running at http://${hostname}:${port}`),
});
