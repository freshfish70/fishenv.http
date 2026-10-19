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
 * - `typed.ts`         — `TypedWsConnection` for `c.ws().messages()` contracts
 * - `route-builder.ts` — `WsRouteBuilder`
 * - `channels/`        — the opt-in channel protocol: `channel()`, `channels()`,
 *                        wire format, `hub.channel(name)` targets
 * - `router.ts`        — `withWs()` mixin
 */

export type {
  AnyChannelImpl,
  AnyEventFn,
  ChannelContext,
  ChannelFactory,
  ChannelHandlerArgs,
  ChannelImplDefinition,
  ClientEventName,
  EventFn,
  JoinFn,
  LeaveFn,
  LeaveReason,
  ServerEventName,
  ServerEventPayload,
} from "./channels/channel.ts";
// Channels (Layer 3)
export { ChannelImpl, channel } from "./channels/channel.ts";
export type { ChannelsOptions } from "./channels/handler.ts";
export { channels } from "./channels/handler.ts";
export type {
  ClientFrame,
  PresenceEntries,
  ServerFrame,
  WireError,
} from "./channels/protocol.ts";
export {
  CHANNELS_PROTOCOL,
  FrameError,
  parseClientFrame,
} from "./channels/protocol.ts";
export { channelRoom, WsChannelTarget } from "./channels/target.ts";
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
  RoomFilter,
  WireFilter,
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
  ChannelCoverage,
  CompleteChannelImpl,
  WsHandlerArgs,
  WsHandlerFn,
  WsProtocolHandler,
  WsRouteInfo,
  WsRouteOptions,
  WsRouterOptions,
} from "./route-builder.ts";
// Route builder
export { WsRouteBuilder } from "./route-builder.ts";
export type { SocketOf, WsRouter } from "./router.ts";
// Router mixin
export { withWs } from "./router.ts";
export type { TicketStore, WsTicketsOptions } from "./tickets.ts";
// Tickets
export { bearerFromProtocol, MemoryTicketStore, WsTickets } from "./tickets.ts";
// Contract-typed sockets
export {
  ContractViolationError,
  checkOutbound,
  parseInbound,
  TypedWsConnection,
} from "./typed.ts";
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
