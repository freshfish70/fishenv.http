# 10 — WebSocket Support

## Decisions

- **Location**: `@fishenv/http/ws` sub-path — not in core.
- **Extension pattern**: Mixin function `withWs(router)` augments the router
  instance with a `.ws()` method.
- **Middleware**: Runs before the WebSocket handshake (for auth, logging, etc.).
- **Message types**: Expose `MessageEvent` as-is — no typed wrapper for v1.

## Extension Pattern

```typescript
// ws/mod.ts
import type { Router } from "@fishenv/http";

// Mixin: adds .ws() to an existing router instance
function withWs<Ctx extends Record<string, unknown>>(
  router: Router<Ctx>,
): Router<Ctx> & WsRouter<Ctx>;

interface WsRouter<Ctx> {
  ws<P extends string>(path: P): WsRouteBuilder<Ctx, BasePathParams<P>>;
}
```

Usage:

```typescript
import { r, serve } from "@fishenv/http";
import { withWs } from "@fishenv/http/ws";

const api = withWs(r({ prefix: "/api" }).use(AuthMiddleware));

api.ws("/chat/:roomId")
  .param("roomId", v.string())
  .with(RoomAuthMiddleware)
  .handle(({ ws, path, ctx }) => {
    ws.addEventListener("message", (event) => {
      ws.send(`[${path.roomId}] ${event.data}`);
    });
    ws.addEventListener("close", () => {
      console.log(`Room ${path.roomId} disconnected`);
    });
  });
```

## WsRouteBuilder

```typescript
class WsRouteBuilder<
  RouterCtx extends Record<string, unknown>,
  Params extends Record<string, unknown>,
> {
  #router: WsRouter<RouterCtx>;
  #path: string;
  #middlewares: MiddlewareFn<any, any>[] = [];
  #paramSchemas = new Map<string, AnySchema>();
  #meta?: RouteMeta;

  meta(data: RouteMeta): this;

  param<Name extends string & keyof Params, S extends AnySchema>(
    name: Name,
    schema: S,
  ): WsRouteBuilder<RouterCtx, MergeParam<Params, Name, S>>;

  with<NewCtx>(
    mw: MiddlewareFn<RouterCtx, NewCtx>,
  ): WsRouteBuilder<RouterCtx & NewCtx, Params>;

  handle(fn: WsHandlerFn<RouterCtx, Params>): FinishedWsRoute;
}

type WsHandlerFn<Ctx, Params> = (args: {
  ws: WebSocket; // Deno's native WebSocket
  path: Params;
  ctx: Ctx;
  req: Request; // original upgrade request (headers, URL)
  container: DIContainer;
}) => void | Promise<void>;
```

## WS Route Dispatch

WS routes are stored as `RouteDefinition` with `kind: "ws"`. The main
`dispatch()` detects this and branches:

```typescript
// core/compose.ts — inside dispatch()

if (matched.definition.kind === "ws") {
  // 1. Run middleware to build ctx (auth happens here)
  const ctx = await runMiddlewarePipeline(
    req,
    matched.definition.middlewares,
    container,
  );

  // 2. Validate path params
  const path = await validatePathParams(
    matched.params,
    matched.definition.paramSchemas,
  );

  // 3. Upgrade the connection
  const { socket, response } = Deno.upgradeWebSocket(req);

  // 4. Call handler asynchronously — does not block the upgrade response
  queueMicrotask(async () => {
    try {
      await (matched.definition as WsRouteDefinition).wsHandler({
        ws: socket,
        path,
        ctx,
        req,
        container,
      });
    } catch (err) {
      console.error("[fishenv.ws] WebSocket handler error:", err);
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1011, "Internal Error");
      }
    }
  });

  // 5. Return the HTTP 101 Switching Protocols response
  return response;
}
```

## WsRouteDefinition (internal)

```typescript
interface WsRouteDefinition extends Omit<RouteDefinition, "kind" | "handler"> {
  kind: "ws";
  wsHandler: WsHandlerFn<any, any>;
}
```

## Files to Create

- `ws/mod.ts` — `withWs()`, `WsRouteBuilder`, `WsHandlerFn`
- `ws/ws.test.ts` — test WS upgrade, middleware execution, error handling on
  handler throw
