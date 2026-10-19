/** The `withWs()` mixin that adds `.ws()` to a core `Router`. */

import type {
  AnyWsContract,
  InferSocket,
  WsContract,
} from "../contract/index.ts";
import type {
  BasePathParams,
  RouteBuilder,
  Router,
  RouterRef,
} from "../core/index.ts";
import { createRouteBuilder } from "../core/index.ts";
import type { WsConnection } from "./connection.ts";
import { WsRouteBuilder, type WsRouterOptions } from "./route-builder.ts";
import type { TypedWsConnection } from "./typed.ts";

/** The `socket` type handlers get for a contract. */
export type SocketOf<C extends AnyWsContract> =
  InferSocket<C>["kind"] extends "messages"
    ? TypedWsConnection<
        InferSocket<C>["clientMessage"],
        InferSocket<C>["serverMessageIn"]
      >
    : WsConnection;

export interface WsRouter<Ctx extends Record<string, unknown>> {
  ws<P extends string>(
    path: P,
  ): WsRouteBuilder<Ctx, Record<never, never>, BasePathParams<P>>;
  /** Implement a `c.ws()` contract: path, params and protocol come from it. */
  ws<C extends AnyWsContract>(
    contract: C,
  ): WsRouteBuilder<
    Ctx,
    Record<never, never>,
    InferSocket<C>["params"],
    SocketOf<C>
  >;
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

  const ws = (pathOrContract: string | AnyWsContract) => {
    if (typeof pathOrContract === "string") {
      return new WsRouteBuilder(
        createRouteBuilder<Ctx, string>(
          router as RouterRef,
          "GET",
          pathOrContract,
        ),
        { routerOrigins: [...routerOrigins] },
      );
    }

    const contract = (pathOrContract as WsContract<string>)._definition;
    // biome-ignore lint/suspicious/noExplicitAny: params are typed via the contract
    let inner: RouteBuilder<Ctx, any, "none", any, any, undefined> =
      createRouteBuilder<Ctx, string>(
        router as RouterRef,
        "GET",
        contract.path,
      );
    for (const [name, schema] of contract.paramSchemas) {
      inner = inner.param(name as never, schema);
    }
    return new WsRouteBuilder(inner, {
      routerOrigins: [...routerOrigins],
      protocols: contract.protocols,
      contract,
    });
  };

  Object.defineProperty(target, "ws", {
    value: ws,
    enumerable: false,
    configurable: true,
  });

  return target;
}
