import { assertEquals } from "@std/assert";
import { assertRejects } from "@std/assert";
import {
  coerceToResponse,
  dispatch,
  runInterceptors,
  runMiddlewarePipeline,
} from "./compose.ts";
import type { DIContainer, RouteDefinition } from "./types.ts";

const stubContainer: DIContainer = {
  get: () => {
    throw new Error("no DI in tests");
  },
};

const dummyReq = new Request("http://localhost/test");

// ---------------------------------------------------------------------------
// runMiddlewarePipeline
// ---------------------------------------------------------------------------

Deno.test("runMiddlewarePipeline — empty pipeline returns base ctx", async () => {
  const ctx = await runMiddlewarePipeline(dummyReq, [], stubContainer);
  assertEquals(ctx.req, dummyReq);
});

Deno.test("runMiddlewarePipeline — merges middleware outputs", async () => {
  const mw1 = () => ({ user: "alice" });
  const mw2 = () => ({ role: "admin" });

  const ctx = await runMiddlewarePipeline(dummyReq, [mw1, mw2], stubContainer);
  assertEquals(ctx.user, "alice");
  assertEquals(ctx.role, "admin");
});

Deno.test("runMiddlewarePipeline — later middleware sees earlier ctx", async () => {
  const mw1 = () => ({ count: 1 });
  const mw2 = (ctx: Record<string, unknown>) => ({
    doubled: (ctx.count as number) * 2,
  });

  const ctx = await runMiddlewarePipeline(
    dummyReq,
    [mw1, mw2],
    stubContainer,
  );
  assertEquals(ctx.doubled, 2);
});

Deno.test("runMiddlewarePipeline — async middleware works", async () => {
  const mw = async () => {
    await Promise.resolve();
    return { async: true };
  };

  const ctx = await runMiddlewarePipeline(dummyReq, [mw], stubContainer);
  assertEquals(ctx.async, true);
});

// ---------------------------------------------------------------------------
// runInterceptors
// ---------------------------------------------------------------------------

Deno.test("runInterceptors — before runs before handler", async () => {
  const order: string[] = [];

  const response = await runInterceptors(
    [{
      before: () => {
        order.push("before");
      },
      after: ({ response }) => {
        order.push("after");
        return response;
      },
    }],
    dummyReq,
    {},
    async () => {
      order.push("handler");
      return new Response("ok");
    },
  );

  assertEquals(order, ["before", "handler", "after"]);
  assertEquals(await response.text(), "ok");
});

Deno.test("runInterceptors — after runs in reverse order", async () => {
  const order: string[] = [];

  await runInterceptors(
    [
      {
        after: ({ response }) => {
          order.push("after-1");
          return response;
        },
      },
      {
        after: ({ response }) => {
          order.push("after-2");
          return response;
        },
      },
    ],
    dummyReq,
    {},
    async () => new Response(),
  );

  assertEquals(order, ["after-2", "after-1"]);
});

Deno.test("runInterceptors — shared state between before and after", async () => {
  let elapsed: number | undefined;

  await runInterceptors(
    [{
      before: ({ state }) => {
        state.start = 100;
      },
      after: ({ response, state }) => {
        elapsed = 200 - (state.start as number);
        return response;
      },
    }],
    dummyReq,
    {},
    async () => new Response(),
  );

  assertEquals(elapsed, 100);
});

Deno.test("runInterceptors — after can modify response", async () => {
  const response = await runInterceptors(
    [{
      after: ({ response }) => {
        const headers = new Headers(response.headers);
        headers.set("X-Custom", "yes");
        return new Response(response.body, {
          status: response.status,
          headers,
        });
      },
    }],
    dummyReq,
    {},
    async () => new Response("body"),
  );

  assertEquals(response.headers.get("X-Custom"), "yes");
});

// ---------------------------------------------------------------------------
// coerceToResponse
// ---------------------------------------------------------------------------

Deno.test("coerceToResponse — passes through Response", () => {
  const def = { outputSchema: undefined } as unknown as RouteDefinition;
  const res = new Response("ok");
  assertEquals(coerceToResponse(res, def), res);
});

Deno.test("coerceToResponse — serializes plain object with outputSchema", async () => {
  const def = { outputSchema: {} } as unknown as RouteDefinition;
  const res = coerceToResponse({ id: 1 }, def);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { id: 1 });
});

Deno.test("coerceToResponse — throws without outputSchema and non-Response", () => {
  const def = { outputSchema: undefined } as unknown as RouteDefinition;
  let threw = false;
  try {
    coerceToResponse({ id: 1 }, def);
  } catch (e) {
    threw = true;
    assertEquals(e instanceof TypeError, true);
  }
  assertEquals(threw, true);
});

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

Deno.test("dispatch — runs full pipeline", async () => {
  const def: RouteDefinition = {
    method: "GET",
    path: "/test",
    middlewares: [() => ({ user: "alice" })],
    paramSchemas: new Map(),
    inputKind: "none",
    inputOptions: {},
    outputSchema: {} as RouteDefinition["outputSchema"],
    interceptors: [],
    // deno-lint-ignore no-explicit-any
    handler: (({ ctx }: any) => {
      return { user: ctx.user };
    }) as any,
    kind: "http",
  };

  const response = await dispatch(
    dummyReq,
    def,
    {},
    stubContainer,
    [],
  );

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { user: "alice" });
});

Deno.test("dispatch — error handler chain catches errors", async () => {
  const def: RouteDefinition = {
    method: "GET",
    path: "/fail",
    middlewares: [],
    paramSchemas: new Map(),
    inputKind: "none",
    inputOptions: {},
    interceptors: [],
    handler: () => {
      throw new Error("boom");
    },
    kind: "http",
  };

  const response = await dispatch(
    dummyReq,
    def,
    {},
    stubContainer,
    [
      (err) => {
        if (err instanceof Error && err.message === "boom") {
          return Response.json({ caught: true }, { status: 500 });
        }
      },
    ],
  );

  assertEquals(response.status, 500);
  assertEquals(await response.json(), { caught: true });
});

Deno.test("dispatch — error falls through to default handler", async () => {
  const def: RouteDefinition = {
    method: "GET",
    path: "/fail",
    middlewares: [],
    paramSchemas: new Map(),
    inputKind: "none",
    inputOptions: {},
    interceptors: [],
    handler: () => {
      throw new Error("unhandled");
    },
    kind: "http",
  };

  const response = await dispatch(
    dummyReq,
    def,
    {},
    stubContainer,
    [() => undefined], // passes to next
  );

  assertEquals(response.status, 500);
  const body = await response.json();
  assertEquals(body.error, "Internal Server Error");
});
