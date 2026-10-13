import { expect, test } from "bun:test";
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

test("runMiddlewarePipeline — empty pipeline returns base ctx", async () => {
  const ctx = await runMiddlewarePipeline(dummyReq, [], stubContainer);
  expect(ctx.req).toEqual(dummyReq);
});

test("runMiddlewarePipeline — merges middleware outputs", async () => {
  const mw1 = () => ({ user: "alice" });
  const mw2 = () => ({ role: "admin" });

  const ctx = await runMiddlewarePipeline(dummyReq, [mw1, mw2], stubContainer);
  expect(ctx.user).toEqual("alice");
  expect(ctx.role).toEqual("admin");
});

test("runMiddlewarePipeline — later middleware sees earlier ctx", async () => {
  const mw1 = () => ({ count: 1 });
  const mw2 = (ctx: Record<string, unknown>) => ({
    doubled: (ctx.count as number) * 2,
  });

  const ctx = await runMiddlewarePipeline(dummyReq, [mw1, mw2], stubContainer);
  expect(ctx.doubled).toEqual(2);
});

test("runMiddlewarePipeline — async middleware works", async () => {
  const mw = async () => {
    await Promise.resolve();
    return { async: true };
  };

  const ctx = await runMiddlewarePipeline(dummyReq, [mw], stubContainer);
  expect(ctx.async).toEqual(true);
});

// ---------------------------------------------------------------------------
// runInterceptors
// ---------------------------------------------------------------------------

test("runInterceptors — before runs before handler", async () => {
  const order: string[] = [];

  const response = await runInterceptors(
    [
      {
        before: () => {
          order.push("before");
        },
        after: ({ response }) => {
          order.push("after");
          return response;
        },
      },
    ],
    dummyReq,
    {},
    async () => {
      order.push("handler");
      return new Response("ok");
    },
  );

  expect(order).toEqual(["before", "handler", "after"]);
  expect(await response.text()).toEqual("ok");
});

test("runInterceptors — after runs in reverse order", async () => {
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

  expect(order).toEqual(["after-2", "after-1"]);
});

test("runInterceptors — shared state between before and after", async () => {
  let elapsed: number | undefined;

  await runInterceptors(
    [
      {
        before: ({ state }) => {
          state.start = 100;
        },
        after: ({ response, state }) => {
          elapsed = 200 - (state.start as number);
          return response;
        },
      },
    ],
    dummyReq,
    {},
    async () => new Response(),
  );

  expect(elapsed).toEqual(100);
});

test("runInterceptors — after can modify response", async () => {
  const response = await runInterceptors(
    [
      {
        after: ({ response }) => {
          const headers = new Headers(response.headers);
          headers.set("X-Custom", "yes");
          return new Response(response.body, {
            status: response.status,
            headers,
          });
        },
      },
    ],
    dummyReq,
    {},
    async () => new Response("body"),
  );

  expect(response.headers.get("X-Custom")).toEqual("yes");
});

// ---------------------------------------------------------------------------
// coerceToResponse
// ---------------------------------------------------------------------------

test("coerceToResponse — passes through Response", () => {
  const def = { outputSchema: undefined } as unknown as RouteDefinition;
  const res = new Response("ok");
  expect(coerceToResponse(res, def)).toEqual(res);
});

test("coerceToResponse — serializes plain object with outputSchema", async () => {
  const def = { outputSchema: {} } as unknown as RouteDefinition;
  const res = coerceToResponse({ id: 1 }, def);
  expect(res.status).toEqual(200);
  expect(await res.json()).toEqual({ id: 1 });
});

test("coerceToResponse — throws without outputSchema and non-Response", () => {
  const def = { outputSchema: undefined } as unknown as RouteDefinition;
  let threw = false;
  try {
    coerceToResponse({ id: 1 }, def);
  } catch (e) {
    threw = true;
    expect(e instanceof TypeError).toEqual(true);
  }
  expect(threw).toEqual(true);
});

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

test("dispatch — runs full pipeline", async () => {
  const def: RouteDefinition = {
    method: "GET",
    path: "/test",
    middlewares: [() => ({ user: "alice" })],
    paramSchemas: new Map(),
    inputKind: "none",
    inputOptions: {},
    outputSchema: {} as RouteDefinition["outputSchema"],
    interceptors: [],
    // biome-ignore lint/suspicious/noExplicitAny: intentional any
    handler: (({ ctx }: any) => {
      return { user: ctx.user };
    }) as any,
    kind: "http",
  };

  const response = await dispatch(dummyReq, def, {}, stubContainer, []);

  expect(response.status).toEqual(200);
  expect(await response.json()).toEqual({ user: "alice" });
});

test("dispatch — error handler chain catches errors", async () => {
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

  const response = await dispatch(dummyReq, def, {}, stubContainer, [
    (err) => {
      if (err instanceof Error && err.message === "boom") {
        return Response.json({ caught: true }, { status: 500 });
      }
    },
  ]);

  expect(response.status).toEqual(500);
  expect(await response.json()).toEqual({ caught: true });
});

test("dispatch — error falls through to default handler", async () => {
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

  expect(response.status).toEqual(500);
  const body = await response.json();
  expect(body.error).toEqual("Internal Server Error");
});
