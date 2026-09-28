/** The `withSse()` mixin that adds `.sse()` to a core `Router`. */

import { createRouteBuilder } from "@fishenv/http";
import type { BasePathParams, Router, RouterRef } from "@fishenv/http";
import { SseRouteBuilder } from "./route-builder.ts";

export interface SseRouter<Ctx extends Record<string, unknown>> {
  sse<P extends string>(
    path: P,
  ): SseRouteBuilder<Ctx, Record<never, never>, BasePathParams<P>>;
}

/**
 * `.use()` returns a *new* router, so apply `withSse` last:
 * `withSse(r({ prefix: "/api" }).use(auth))`.
 */
export function withSse<Ctx extends Record<string, unknown>>(
  router: Router<Ctx>,
): Router<Ctx> & SseRouter<Ctx> {
  const target = router as Router<Ctx> & SseRouter<Ctx>;

  Object.defineProperty(target, "sse", {
    value: <P extends string>(path: P) =>
      new SseRouteBuilder(
        createRouteBuilder<Ctx, P>(router as RouterRef, "GET", path),
        {},
      ),
    enumerable: false,
    configurable: true,
  });

  return target;
}
