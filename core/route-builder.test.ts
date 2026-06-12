import { assertEquals } from "@std/assert";
import { assertType, type IsExact } from "@std/testing/types";
import {
  createRouteBuilder,
  FinishedRoute,
  RouteBuilder,
  type RouterRef,
} from "./route-builder.ts";
import type {
  AnySchema,
  HandlerArgs,
  InputOptions,
  MiddlewareFn,
  RouteDefinition,
  ValibotSchema,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Stub router for testing
// ---------------------------------------------------------------------------

function stubRouter(prefix = ""): RouterRef & { routes: RouteDefinition[] } {
  const routes: RouteDefinition[] = [];
  return {
    routes,
    _registerRoute(def: RouteDefinition) {
      routes.push(def);
    },
    _getMiddlewares() {
      return [];
    },
    _getPrefix() {
      return prefix;
    },
  };
}

// ---------------------------------------------------------------------------
// Basic builder chain
// ---------------------------------------------------------------------------

Deno.test("RouteBuilder — handle() registers a route definition", () => {
  const router = stubRouter();
  const finished = createRouteBuilder(router, "GET", "/users")
    .handle(() => new Response("ok"));

  assertEquals(router.routes.length, 1);
  assertEquals(router.routes[0].method, "GET");
  assertEquals(router.routes[0].path, "/users");
  assertEquals(router.routes[0].kind, "http");
  assertEquals(finished instanceof FinishedRoute, true);
});

Deno.test("RouteBuilder — meta() sets metadata", () => {
  const router = stubRouter();
  createRouteBuilder(router, "POST", "/items")
    .meta({ title: "Create Item", tags: ["items"] })
    .handle(() => new Response());

  assertEquals(router.routes[0].meta?.title, "Create Item");
  assertEquals(router.routes[0].meta?.tags, ["items"]);
});

Deno.test("RouteBuilder — param() records param schema", () => {
  const router = stubRouter();
  const schema = {} as AnySchema;
  createRouteBuilder(router, "GET", "/users/:id")
    .param("id", schema)
    .handle(() => new Response());

  assertEquals(router.routes[0].paramSchemas.has("id"), true);
  assertEquals(router.routes[0].paramSchemas.get("id"), schema);
});

Deno.test("RouteBuilder — with() adds route-level middleware", () => {
  const router = stubRouter();
  const mw: MiddlewareFn<Record<string, unknown>, { user: string }> = () => ({
    user: "alice",
  });

  createRouteBuilder(router, "GET", "/me")
    .with(mw)
    .handle(() => new Response());

  assertEquals(router.routes[0].middlewares.length, 1);
});

Deno.test("RouteBuilder — input() sets input kind and options", () => {
  const router = stubRouter();
  const bodySchema = {} as AnySchema;

  createRouteBuilder(router, "POST", "/items")
    .input("json", { body: bodySchema })
    .handle(() => new Response());

  assertEquals(router.routes[0].inputKind, "json");
  assertEquals(router.routes[0].inputOptions.body, bodySchema);
});

Deno.test("RouteBuilder — output() sets output schema", () => {
  const router = stubRouter();
  const schema = {} as AnySchema;

  createRouteBuilder(router, "GET", "/items")
    .output(schema)
    .handle(() => new Response());

  assertEquals(router.routes[0].outputSchema, schema);
});

Deno.test("RouteBuilder — intercept() adds interceptor pair", () => {
  const router = stubRouter();

  createRouteBuilder(router, "GET", "/test")
    .intercept(
      ({ state }) => {
        state.x = 1;
      },
      ({ response }) => response,
    )
    .handle(() => new Response());

  assertEquals(router.routes[0].interceptors.length, 1);
  assertEquals(typeof router.routes[0].interceptors[0].before, "function");
  assertEquals(typeof router.routes[0].interceptors[0].after, "function");
});

Deno.test("RouteBuilder — catch() on FinishedRoute sets error handler", () => {
  const router = stubRouter();
  const errorFn = () => new Response("error", { status: 500 });

  createRouteBuilder(router, "GET", "/fail")
    .handle(() => new Response())
    .catch(errorFn);

  assertEquals(router.routes[0].errorHandler, errorFn);
});

// ---------------------------------------------------------------------------
// Prefix merging
// ---------------------------------------------------------------------------

Deno.test("RouteBuilder — prepends router prefix to path", () => {
  const router = stubRouter("/api/v1");
  createRouteBuilder(router, "GET", "/users")
    .handle(() => new Response());

  assertEquals(router.routes[0].path, "/api/v1/users");
});

// ---------------------------------------------------------------------------
// Router middleware prepended
// ---------------------------------------------------------------------------

Deno.test("RouteBuilder — router middlewares prepended before route middlewares", () => {
  const routerMw = () => ({ fromRouter: true });
  const routeMw = () => ({ fromRoute: true });

  const router: RouterRef & { routes: RouteDefinition[] } = {
    routes: [],
    _registerRoute(def) {
      this.routes.push(def);
    },
    _getMiddlewares() {
      return [routerMw];
    },
    _getPrefix() {
      return "";
    },
  };

  createRouteBuilder(router, "GET", "/test")
    .with(routeMw)
    .handle(() => new Response());

  assertEquals(router.routes[0].middlewares.length, 2);
  assertEquals(router.routes[0].middlewares[0], routerMw);
  assertEquals(router.routes[0].middlewares[1], routeMw);
});

// ---------------------------------------------------------------------------
// Immutability — type-changing methods return new instances
// ---------------------------------------------------------------------------

Deno.test("RouteBuilder — param() returns a new builder instance", () => {
  const router = stubRouter();
  const b1 = createRouteBuilder(router, "GET", "/users/:id");
  const b2 = b1.param("id", {} as AnySchema);
  assertEquals(b1 !== (b2 as unknown), true);
});

Deno.test("RouteBuilder — with() returns a new builder instance", () => {
  const router = stubRouter();
  const b1 = createRouteBuilder(router, "GET", "/test");
  const b2 = b1.with(() => ({ x: 1 }));
  assertEquals(b1 !== (b2 as unknown), true);
});

Deno.test("RouteBuilder — meta() returns same instance", () => {
  const router = stubRouter();
  const b1 = createRouteBuilder(router, "GET", "/test");
  const b2 = b1.meta({ title: "test" });
  assertEquals(b1, b2);
});

// ---------------------------------------------------------------------------
// Compile-time type tests
// ---------------------------------------------------------------------------

Deno.test("RouteBuilder type — handler receives inferred path params", () => {
  const router = stubRouter();
  createRouteBuilder<Record<never, never>, "/users/:id">(
    router,
    "GET",
    "/users/:id",
  ).handle((args) => {
    // args.path should have { id: string }
    assertType<IsExact<typeof args.path.id, string>>(true);
    return new Response();
  });
});

Deno.test("RouteBuilder type — with() extends context type", () => {
  const router = stubRouter();
  createRouteBuilder<Record<never, never>, "/test">(router, "GET", "/test")
    .with(() => ({ user: "alice" as const }))
    .handle((args) => {
      assertType<IsExact<typeof args.ctx.user, "alice">>(true);
      return new Response();
    });
});

Deno.test("RouteBuilder type — chained .with() merges context", () => {
  const router = stubRouter();
  createRouteBuilder<Record<never, never>, "/test">(router, "GET", "/test")
    .with(() => ({ a: 1 as const }))
    .with(() => ({ b: 2 as const }))
    .handle((args) => {
      assertType<IsExact<typeof args.ctx.a, 1>>(true);
      assertType<IsExact<typeof args.ctx.b, 2>>(true);
      return new Response();
    });
});
