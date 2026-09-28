# 11 — Server-Sent Events (SSE)

**Status: implemented and verified** (`sse/mod.ts`, `sse/sse.test.ts`, 28 tests
incl. an end-to-end run over a real socket).

## Decisions

- **Location**: `@fishenv/http/sse` sub-path (`"./sse"` export + `@fishenv/http`
  self-import entry added to the root `deno.json`).
- **Extension pattern**: Mixin function `withSse(router)`.
- **No core changes.** An SSE route is a plain `GET` route whose handler returns
  a streaming `Response`. `SseRouteBuilder` wraps the core `RouteBuilder`, so
  middleware, path-param validation, interceptors and the error chain all work
  unchanged. `dispatch()` needs no `kind === "sse"` branch.
- **Targeted delivery** via `SseHub` — a keyed registry of live connections that
  any service can hold and push to. This is the headline capability; broadcast
  is just `send` with no key.
- **Multiline data**: Auto-split `\n` / `\r\n` / `\r` across `data:` lines.
- **Last-Event-ID**: `sse.lastEventId`, from the header with a `?lastEventId=`
  query fallback (`EventSource` cannot set request headers).
- **Typed events / event replay from `Last-Event-ID`**: v2.

## Issues found in the original draft

| #  | Problem                                                                                                                                                       | Resolution                                                                                           |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1  | No way to reach a connection from outside the handler — only the closure could send.                                                                          | `SseHub` registry keyed by an app identifier.                                                        |
| 2  | `ReadableStream<string>` + `enqueue(string)` — `Response` requires `BufferSource`; this throws at runtime.                                                    | `ReadableStream<Uint8Array>` + `TextEncoder`.                                                        |
| 3  | `cancel()` only called `cleanup()`, so the keepalive interval and registry entry leaked on disconnect.                                                        | `cancel()` calls `connection.close()`, which runs _all_ close callbacks.                             |
| 4  | Keepalive called `controller.enqueue` directly, bypassing the closed-guard → `TypeError` after close.                                                         | Heartbeat goes through `sse.comment()`, which is guarded and try/caught.                             |
| 5  | No backpressure handling — a stalled client grows the server heap without bound.                                                                              | `ByteLengthQueuingStrategy` + `desiredSize` check; `onOverflow: "close" \| "drop"`, default `close`. |
| 6  | `id` / `event` written verbatim → **SSE frame injection** if either is attacker-influenced.                                                                   | CR/LF/NUL stripped from all field values.                                                            |
| 7  | `req.signal.addEventListener("abort", …)` — under `Deno.serve`'s legacy semantics the signal also fires on _successful_ delivery, and warns on every request. | Removed. Stream `cancel()` is the sole disconnect signal; verified e2e.                              |
| 8  | `start()` awaited the user handler, so a long-lived handler blocks the stream source.                                                                         | Handler kicked off in a detached async IIFE.                                                         |
| 9  | Cleanup typed `() => void`, so async teardown could not be expressed.                                                                                         | `SseCleanupFn = () => unknown`; promises are awaited for error logging.                              |
| 10 | Error handling after stream start returned a `Response` that could never be sent.                                                                             | Log + close, explicitly documented.                                                                  |
| 11 | `Connection: keep-alive` is meaningless (illegal on HTTP/2); nothing prevented proxy/compression buffering.                                                   | Dropped; `cache-control: no-transform` + `x-accel-buffering: no`.                                    |
| 12 | A local registry only reaches connections on _this_ process.                                                                                                  | Optional `SseTransport` seam with origin-stamped messages for Redis/NATS fan-out.                    |

## Targeted send

```typescript
import { SseHub } from "@fishenv/http/sse";

// Subclass to get a DI token.
class UserEvents extends SseHub {}

// Route: register the connection under the authenticated user id.
api.sse("/events")
  .keepalive(30_000)
  .subscribe(UserEvents, ({ ctx }) => ctx.user.id);

// Any service, anywhere:
class OrderService {
  constructor(private readonly events: UserEvents) {}

  ship(order: Order) {
    this.events.send(order.userId, { orderId: order.id }, {
      event: "order.shipped",
    });
  }
}
```

One key maps to _many_ connections (tabs, devices); `send()` fans out to all of
them and returns the local delivery count. Connections deregister themselves on
close, so applications keep no bookkeeping.

The imperative form is equivalent — `add()` returns the unregister function,
which is exactly the cleanup contract of `handle()`:

```typescript
api.sse("/events").handle(({ sse, ctx, container }) =>
  container.get(UserEvents).add(ctx.user.id, sse)
);
```

## API

```typescript
class SseConnection {
  readonly id: string; // unique per connection
  readonly lastEventId: string | null;
  readonly req: Request;
  get closed(): boolean;
  get bufferedBytes(): number;

  send(data: unknown, opts?: SseEventOptions): boolean; // false = dropped
  comment(text?: string): boolean;
  retry(ms: number): boolean;
  close(): void;
  onClose(fn: SseCleanupFn): void; // runs immediately if already closed
}

class SseHub {
  constructor(options?: { transport?: SseTransport });
  add(key: string, connection: SseConnection): () => void;
  send(key: string, data: unknown, opts?: SseEventOptions): number;
  sendMany(
    keys: Iterable<string>,
    data: unknown,
    opts?: SseEventOptions,
  ): number;
  broadcast(data: unknown, opts?: SseEventOptions): number;
  close(key: string): number;
  closeAll(): void;
  has(key: string): boolean;
  count(key?: string): number;
  keys(): string[];
  connections(key: string): SseConnection[];
}

class SseRouteBuilder<RouterCtx, RouteCtx, Params> {
  meta(data: RouteMeta): this;
  keepalive(intervalMs: number): this;
  retry(ms: number): this;
  backpressure(
    opts: { highWaterMark?: number; onOverflow?: SseOverflowPolicy },
  ): this;
  param(name, schema): SseRouteBuilder<RouterCtx, RouteCtx, MergeParam<...>>;
  with(mw): SseRouteBuilder<RouterCtx, RouteCtx & NewCtx, Params>;
  handle(fn: SseHandlerFn<RouterCtx & RouteCtx, Params>): FinishedRoute;
  subscribe(hubToken, keyFn): FinishedRoute;
}
```

## Caveats (documented, not bugs)

- **Errors after the stream opens cannot change the status.** Middleware and
  param validation run _before_ the stream, so auth failures still return a
  proper `401`/`400` JSON body. `.catch()` on an SSE route only covers that
  pre-stream window.
- **`withSse()` mutates the router instance.** `.use()` returns a _new_ router
  without `.sse()`, so apply `withSse` last.
- **Without `keepalive`, dead sockets may linger in the hub.** A TCP write is
  what surfaces the disconnect; a silent stream has nothing to fail on.
- **`SseHub` is per-process.** Use `SseTransport` for horizontal scaling.
- One `setInterval` per connection is fine into the thousands; a shared timer
  wheel is a v2 concern.

## Files

Implementation (`sse/`):

| File               | Responsibility                                                |
| ------------------ | ------------------------------------------------------------- |
| `types.ts`         | Shared data types, free of class references (no import cycle) |
| `encode.ts`        | `text/event-stream` framing + field sanitization              |
| `connection.ts`    | `SseConnection` — one live stream, close/cleanup lifecycle    |
| `response.ts`      | `createSseResponse()` — request → streaming `Response`        |
| `hub.ts`           | `SseHub` — keyed registry, targeted send, transport fan-out   |
| `route-builder.ts` | `SseRouteBuilder`, `SseHandlerFn`                             |
| `router.ts`        | `withSse()` mixin                                             |
| `mod.ts`           | Public re-exports only                                        |

Tests mirror the modules: `encode.test.ts`, `connection.test.ts`, `hub.test.ts`,
`router.test.ts` (incl. the e2e `Deno.serve` case), with shared helpers in
`_test_utils.ts`.
