# 11 — Server-Sent Events (SSE)

## Decisions
- **Location**: `@fishenv/http/sse` sub-path.
- **Extension pattern**: Mixin function `withSse(router)`.
- **Multiline data**: Auto-split `\n` across multiple `data:` lines (per spec).
- **Last-Event-ID**: Passed to handler via `sse.lastEventId` (from request header).
- **Typed events**: v2. v1 uses untyped `send()`.

## Extension Pattern

```typescript
import { r, serve } from "@fishenv/http"
import { withSse } from "@fishenv/http/sse"

const api = withSse(r({ prefix: "/api" }).use(AuthMiddleware))

api.sse("/events")
  .with(SubscriptionMiddleware)
  .keepalive(30_000)
  .handle(({ sse, ctx, container }) => {
    const sub = container.get(EventBus).subscribe(ctx.user.id)

    sub.on("event", (data) => sse.send(data, { event: "update" }))

    // Return cleanup function
    return () => sub.unsubscribe()
  })
```

## SseController

```typescript
// sse/mod.ts

class SseController {
  readonly lastEventId: string | null    // from Last-Event-ID request header

  constructor(
    private readonly controller: ReadableStreamDefaultController<string>,
    req: Request,
  ) {
    this.lastEventId = req.headers.get("last-event-id")
  }

  send(data: string | object, opts?: SseEventOptions): void {
    if (this.#closed) return

    let message = ""
    if (opts?.id)    message += `id: ${opts.id}\n`
    if (opts?.event) message += `event: ${opts.event}\n`
    if (opts?.retry) message += `retry: ${opts.retry}\n`

    const dataStr = typeof data === "string" ? data : JSON.stringify(data)
    // Auto-split multiline data per SSE spec
    for (const line of dataStr.split("\n")) {
      message += `data: ${line}\n`
    }
    message += "\n"   // blank line = end of event

    this.controller.enqueue(message)
  }

  close(): void {
    if (!this.#closed) {
      this.#closed = true
      this.controller.close()
      this.#closeCallbacks.forEach(fn => fn())
    }
  }

  onClose(fn: () => void): void {
    this.#closeCallbacks.push(fn)
  }

  #closed = false
  #closeCallbacks: (() => void)[] = []
}

interface SseEventOptions {
  event?: string
  id?: string
  retry?: number    // reconnection delay in ms
}
```

## SseRouteBuilder

```typescript
class SseRouteBuilder<Ctx, Params> {
  with<NewCtx>(mw: MiddlewareFn<Ctx, NewCtx>): SseRouteBuilder<Ctx & NewCtx, Params>
  param<Name extends string, S extends AnySchema>(name: Name, schema: S): SseRouteBuilder<Ctx, MergeParam<Params, Name, S>>
  meta(data: RouteMeta): this
  keepalive(intervalMs: number): this   // send SSE comment every N ms as heartbeat

  handle(fn: SseHandlerFn<Ctx, Params>): FinishedRoute
}

type SseHandlerFn<Ctx, Params> = (args: {
  sse: SseController
  path: Params
  ctx: Ctx
  req: Request
  container: DIContainer
}) => void | Promise<void> | (() => void)   // optional sync cleanup fn
```

## SSE Dispatch

```typescript
// Inside dispatch() for kind === "sse":

const ctx = await runMiddlewarePipeline(req, middlewares, container)
const path = await validatePathParams(rawParams, paramSchemas)

let cleanup: (() => void) | undefined

const stream = new ReadableStream<string>({
  async start(controller) {
    const sse = new SseController(controller, req)

    // Abort on client disconnect
    req.signal.addEventListener("abort", () => sse.close())

    // Keepalive heartbeat
    let heartbeat: number | undefined
    if (def.keepaliveMs) {
      heartbeat = setInterval(() => controller.enqueue(": heartbeat\n\n"), def.keepaliveMs)
      sse.onClose(() => clearInterval(heartbeat))
    }

    try {
      const result = await def.sseHandler({ sse, path, ctx, req, container })
      if (typeof result === "function") {
        cleanup = result
        sse.onClose(cleanup)
      }
    } catch (err) {
      // Run error handlers
      for (const handler of errorHandlers) {
        const res = await handler(err, { req })
        if (res) {
          // Can't change HTTP status after streaming started — log and close
          console.error("[fishenv.sse] Handler error after stream started:", err)
          break
        }
      }
      sse.close()
    }
  },
  cancel() {
    cleanup?.()
  },
})

return new Response(stream, {
  headers: {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",    // disable nginx buffering
  },
})
```

## Files to Create
- `sse/mod.ts` — `SseController`, `SseRouteBuilder`, `withSse()`, SSE dispatch logic
- `sse/sse.test.ts` — multiline split, Last-Event-ID, keepalive, cleanup on disconnect
