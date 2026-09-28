/**
 * Server-Sent Events for `@fishenv/http`.
 *
 * An SSE route is an ordinary `GET` route whose handler returns a streaming
 * `Response`, so middleware, path-param validation, interceptors and the error
 * chain all work unchanged — no core dispatch branching is required.
 *
 * Live connections can be registered in an {@link SseHub} so that any service
 * can push to a specific client later:
 *
 * ```ts
 * class UserEvents extends SseHub {}
 *
 * api.sse("/events").keepalive(30_000).subscribe(UserEvents, ({ ctx }) => ctx.user.id);
 *
 * // elsewhere, e.g. inside a use case
 * userEvents.send(userId, { type: "order.shipped" }, { event: "notification" });
 * ```
 *
 * Module layout:
 * - `types.ts`         — shared data types
 * - `encode.ts`        — `text/event-stream` framing
 * - `connection.ts`    — `SseConnection`, a single live stream
 * - `response.ts`      — `createSseResponse()`, request → streaming response
 * - `hub.ts`           — `SseHub`, keyed registry for targeted sends
 * - `route-builder.ts` — `SseRouteBuilder`
 * - `router.ts`        — `withSse()` mixin
 */

// Types
export type {
  SseCleanupFn,
  SseConnectionOptions,
  SseEventOptions,
  SseHubOptions,
  SseOverflowPolicy,
  SseTransport,
  SseTransportMessage,
} from "./types.ts";

// Framing
export { encodeSseComment, encodeSseEvent, encodeSseRetry } from "./encode.ts";

// Connection
export { SseConnection } from "./connection.ts";

// Response
export { createSseResponse } from "./response.ts";
export type { SseOpenFn } from "./response.ts";

// Hub
export { SseHub } from "./hub.ts";

// Route builder
export { SseRouteBuilder } from "./route-builder.ts";
export type { SseHandlerArgs, SseHandlerFn } from "./route-builder.ts";

// Router mixin
export { withSse } from "./router.ts";
export type { SseRouter } from "./router.ts";
