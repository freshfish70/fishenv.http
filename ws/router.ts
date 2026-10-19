/** The `withWs()` mixin that adds `.ws()` to a core `Router`. */

import type { BasePathParams, Router, RouterRef } from "../core/index.ts";
import { createRouteBuilder } from "../core/index.ts";
import { WsRouteBuilder, type WsRouterOptions } from "./route-builder.ts";

export interface WsRouter<Ctx extends Record<string, unknown>> {
  ws<P extends string>(
    path: P,
  ): WsRouteBuilder<Ctx, Record<never, never>, BasePathParams<P>>;
}

/**
 * `.use()` returns a *new* router, so apply `withWs` last:
 * `withWs(r({ prefix: "/api" }).use(auth))`.
 *
 * `options.origins` are added to the allowed origins of every ws route
 * registered through this router (on top of the root `cors()` origins).
 */
export function withWs<
  Ctx extends Record<string, unknown>,
  Req extends Record<string, unknown> = Record<never, never>,
>(
  router: Router<Ctx, Req>,
  options: WsRouterOptions = {},
): Router<Ctx, Req> & WsRouter<Ctx> {
  const target = router as Router<Ctx, Req> & WsRouter<Ctx>;
  const routerOrigins = [...(options.origins ?? [])];

  Object.defineProperty(target, "ws", {
    value: <P extends string>(path: P) =>
      new WsRouteBuilder(
        createRouteBuilder<Ctx, P>(router as RouterRef, "GET", path),
        { routerOrigins: [...routerOrigins] },
      ),
    enumerable: false,
    configurable: true,
  });

  return target;
}
