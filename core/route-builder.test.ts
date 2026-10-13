import { expect, expectTypeOf, test } from "bun:test";
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

test("RouteBuilder — handle() registers a route definition", () => {
  const router = stubRouter();
  const finished = createRouteBuilder(router, "GET", "/users").handle(
    () => new Response("ok"),
  );

  expect(router.routes.length).toEqual(1);
  expect(router.routes[0].method).toEqual("GET");
  expect(router.routes[0].path).toEqual("/users");
  expect(router.routes[0].kind).toEqual("http");
  expect(finished instanceof FinishedRoute).toEqual(true);
});

test("RouteBuilder — meta() sets metadata", () => {
  const router = stubRouter();
  createRouteBuilder(router, "POST", "/items")
    .meta({ title: "Create Item", tags: ["items"] })
    .handle(() => new Response());

  expect(router.routes[0].meta?.title).toEqual("Create Item");
  expect(router.routes[0].meta?.tags).toEqual(["items"]);
});

test("RouteBuilder — param() records param schema", () => {
  const router = stubRouter();
  const schema = {} as AnySchema;
  createRouteBuilder(router, "GET", "/users/:id")
    .param("id", schema)
    .handle(() => new Response());

  expect(router.routes[0].paramSchemas.has("id")).toEqual(true);
  expect(router.routes[0].paramSchemas.get("id")).toEqual(schema);
});

test("RouteBuilder — with() adds route-level middleware", () => {
  const router = stubRouter();
  const mw: MiddlewareFn<Record<string, unknown>, { user: string }> = () => ({
    user: "alice",
  });

  createRouteBuilder(router, "GET", "/me")
    .with(mw)
    .handle(() => new Response());

  expect(router.routes[0].middlewares.length).toEqual(1);
});

test("RouteBuilder — input() sets input kind and options", () => {
  const router = stubRouter();
  const bodySchema = {} as AnySchema;

  createRouteBuilder(router, "POST", "/items")
    .input("json", { body: bodySchema })
    .handle(() => new Response());

  expect(router.routes[0].inputKind).toEqual("json");
  expect(router.routes[0].inputOptions.body).toEqual(bodySchema);
});

test("RouteBuilder — output() sets output schema", () => {
  const router = stubRouter();
  const schema = {} as AnySchema;

  createRouteBuilder(router, "GET", "/items")
    .output(schema)
    .handle(() => new Response());

  expect(router.routes[0].outputSchema).toEqual(schema);
});

test("RouteBuilder — intercept() adds interceptor pair", () => {
  const router = stubRouter();

  createRouteBuilder(router, "GET", "/test")
    .intercept(
      ({ state }) => {
        state.x = 1;
      },
      ({ response }) => response,
    )
    .handle(() => new Response());

  expect(router.routes[0].interceptors.length).toEqual(1);
  expect(typeof router.routes[0].interceptors[0].before).toEqual("function");
  expect(typeof router.routes[0].interceptors[0].after).toEqual("function");
});

test("RouteBuilder — catch() on FinishedRoute sets error handler", () => {
  const router = stubRouter();
  const errorFn = () => new Response("error", { status: 500 });

  createRouteBuilder(router, "GET", "/fail")
    .handle(() => new Response())
    .catch(errorFn);

  expect(router.routes[0].errorHandler).toEqual(errorFn);
});

// ---------------------------------------------------------------------------
// Prefix merging
// ---------------------------------------------------------------------------

test("RouteBuilder — prepends router prefix to path", () => {
  const router = stubRouter("/api/v1");
  createRouteBuilder(router, "GET", "/users").handle(() => new Response());

  expect(router.routes[0].path).toEqual("/api/v1/users");
});

// ---------------------------------------------------------------------------
// Router middleware prepended
// ---------------------------------------------------------------------------

test("RouteBuilder — router middlewares prepended before route middlewares", () => {
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

  expect(router.routes[0].middlewares.length).toEqual(2);
  expect(router.routes[0].middlewares[0]).toEqual(routerMw);
  expect(router.routes[0].middlewares[1]).toEqual(routeMw);
});

// ---------------------------------------------------------------------------
// Immutability — type-changing methods return new instances
// ---------------------------------------------------------------------------

test("RouteBuilder — param() returns a new builder instance", () => {
  const router = stubRouter();
  const b1 = createRouteBuilder(router, "GET", "/users/:id");
  const b2 = b1.param("id", {} as AnySchema);
  expect(b1 !== (b2 as unknown)).toEqual(true);
});

test("RouteBuilder — with() returns a new builder instance", () => {
  const router = stubRouter();
  const b1 = createRouteBuilder(router, "GET", "/test");
  const b2 = b1.with(() => ({ x: 1 }));
  expect(b1 !== (b2 as unknown)).toEqual(true);
});

test("RouteBuilder — meta() returns same instance", () => {
  const router = stubRouter();
  const b1 = createRouteBuilder(router, "GET", "/test");
  const b2 = b1.meta({ title: "test" });
  expect(b1).toEqual(b2);
});

// ---------------------------------------------------------------------------
// Compile-time type tests
// ---------------------------------------------------------------------------

test("RouteBuilder type — handler receives inferred path params", () => {
  const router = stubRouter();
  createRouteBuilder<Record<never, never>, "/users/:id">(
    router,
    "GET",
    "/users/:id",
  ).handle((args) => {
    // args.path should have { id: string }
    expectTypeOf<typeof args.path.id>().toEqualTypeOf<string>();
    return new Response();
  });
});

test("RouteBuilder type — with() extends context type", () => {
  const router = stubRouter();
  createRouteBuilder<Record<never, never>, "/test">(router, "GET", "/test")
    .with(() => ({ user: "alice" as const }))
    .handle((args) => {
      expectTypeOf<typeof args.ctx.user>().toEqualTypeOf<"alice">();
      return new Response();
    });
});

test("RouteBuilder type — chained .with() merges context", () => {
  const router = stubRouter();
  createRouteBuilder<Record<never, never>, "/test">(router, "GET", "/test")
    .with(() => ({ a: 1 as const }))
    .with(() => ({ b: 2 as const }))
    .handle((args) => {
      expectTypeOf<typeof args.ctx.a>().toEqualTypeOf<1>();
      expectTypeOf<typeof args.ctx.b>().toEqualTypeOf<2>();
      return new Response();
    });
});
