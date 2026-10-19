/**
 * WebSockets for `@fishenv/http`.
 *
 * A ws route is an ordinary `GET` route: origin checks, middleware (auth),
 * path-param validation and connection limits all run *before* the upgrade,
 * so a rejected handshake is a normal HTTP error and no socket is opened.
 *
 * ```ts
 * const api = withWs(r({ prefix: "/api" }).use(auth));
 *
 * api.ws("/echo/:room")
 *   .maxMessageSize(16 * 1024)
 *   .rateLimit({ messages: 20, perMs: 1000 })
 *   .handle(({ socket, path }) => {
 *     socket.onMessage((msg) => socket.send(`[${path.room}] ${msg.text()}`));
 *   });
 * ```
 *
 * Module layout:
 * - `types.ts`         — shared types, close codes, error → close mapping
 * - `message.ts`       — `WsMessage`, a lazily decoded inbound message
 * - `connection.ts`    — `WsConnection`, a single live socket
 * - `lifecycle.ts`     — per-socket buffering, limits and error handling
 * - `origin.ts`        — CSWSH origin policy
 * - `limits.ts`        — rate limiting and connection counting
 * - `helpers.ts`       — handshake helpers
 * - `hub.ts`           — `WsHub`, keyed registry + server-side rooms
 * - `tickets.ts`       — `WsTickets`, single-use handshake tickets
 * - `route-builder.ts` — `WsRouteBuilder`
 * - `router.ts`        — `withWs()` mixin
 */

export type { WsCloseListener, WsMessageListener } from "./connection.ts";
// Connection
export { WsConnection } from "./connection.ts";
// Handshake helpers
export {
  isWebSocketUpgrade,
  negotiateProtocol,
  requestedProtocols,
  UpgradeRequiredError,
} from "./helpers.ts";
export type {
  WirePayload,
  WsHubOptions,
  WsHubPayload,
  WsTransportMessage,
} from "./hub.ts";
// Hub
export { encodeFrame, WsHub, WsRoomTarget } from "./hub.ts";
export type { LifecycleOptions, WsSetupFn } from "./lifecycle.ts";
// Lifecycle (for custom routes built on core's requestUpgrade)
export { createLifecycle } from "./lifecycle.ts";
export type { WsConnectionLimit } from "./limits.ts";
// Limits
export { ConnectionCounter, TokenBucket } from "./limits.ts";
// Messages
export { WsMessage } from "./message.ts";
export type { OriginPolicy, OriginPredicate, OriginSource } from "./origin.ts";
// Origin policy
export { createOriginPolicy, originSourcesFromCors } from "./origin.ts";
export type {
  WsHandlerArgs,
  WsHandlerFn,
  WsProtocolHandler,
  WsRouteOptions,
  WsRouterOptions,
} from "./route-builder.ts";
// Route builder
export { WsRouteBuilder } from "./route-builder.ts";
export type { WsRouter } from "./router.ts";
// Router mixin
export { withWs } from "./router.ts";
export type { TicketStore, WsTicketsOptions } from "./tickets.ts";
// Tickets
export { bearerFromProtocol, MemoryTicketStore, WsTickets } from "./tickets.ts";
export type {
  WsCleanupFn,
  WsConnectionOptions,
  WsRateLimit,
  WsSendable,
  WsSendResult,
} from "./types.ts";
// Types & close codes
export {
  closeFrameFor,
  MAX_CLOSE_REASON_BYTES,
  truncateReason,
  WsCloseCode,
  WsCloseError,
  WsProtocolError,
} from "./types.ts";
