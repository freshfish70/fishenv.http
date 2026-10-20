import { describe, expect, it } from "bun:test";
import { ForbiddenError } from "./error.ts";
import { type CtxOf, Router, r, serve } from "./router.ts";
import type { MiddlewareFn } from "./types.ts";

const BASE = "http://localhost";

function req(path: string, method = "GET"): Request {
  return new Request(`${BASE}${path}`, { method });
}

// ── Factories ──────────────────────────────────────────────────────────

describe("r() factory", () => {
  it("creates a Router instance", () => {
    const app = r();
    expect(app instanceof Router).toEqual(true);
  });

  it("accepts a prefix option", () => {
    const app = r({ prefix: "/api" });
    app.get("/health").handle(() => new Response("ok"));
    app.build();
    // Prefix is stored internally, tested via routing below
  });
});

// ── Basic routing ──────────────────────────────────────────────────────

describe("Router routing", () => {
  it("GET route returns response", async () => {
    const app = r();
    app.get("/hello").handle(() => new Response("world"));
    app.build();

    const res = await app.fetch(req("/hello"));
    expect(res.status).toEqual(200);
    expect(await res.text()).toEqual("world");
  });

  it("POST route works", async () => {
    const app = r();
    app.post("/items").handle(() => new Response("created", { status: 201 }));
    app.build();

    const res = await app.fetch(req("/items", "POST"));
    expect(res.status).toEqual(201);
  });

  it("all HTTP method helpers work", async () => {
    const app = r();
    const methods = [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ] as const;
    for (const m of methods) {
      const methodLower = m.toLowerCase() as
        | "get"
        | "post"
        | "put"
        | "patch"
        | "delete"
        | "options";
      app[methodLower](`/${m}`).handle(() => new Response(m));
    }
    app.build();

    for (const m of methods) {
      const res = await app.fetch(req(`/${m}`, m));
      expect(await res.text()).toEqual(m);
    }
  });

  it("path params extracted", async () => {
    const app = r();
    app.get("/users/:id").handle(({ path }) => Response.json(path));
    app.build();

    const res = await app.fetch(req("/users/42"));
    expect(await res.json()).toEqual({ id: "42" });
  });

  it("prefix is prepended to route paths", async () => {
    const app = r({ prefix: "/api" });
    app.get("/health").handle(() => new Response("ok"));
    app.build();

    const res = await app.fetch(req("/api/health"));
    expect(res.status).toEqual(200);
    expect(await res.text()).toEqual("ok");
  });
});

// ── 404 / 405 ──────────────────────────────────────────────────────────

describe("Router rest params", () => {
  it("passes the raw remainder of a mounted router to the handler", async () => {
    const files = r();
    files.get("/:path*").handle(({ path }) => Response.json(path));
    const app = r().add("/static", files);
    app.get("/static/health").handle(() => new Response("ok"));
    app.build();

    expect(await (await app.fetch(req("/static/a/b%20c.txt"))).json()).toEqual({
      path: "a/b%20c.txt",
    });
    expect(await (await app.fetch(req("/static"))).json()).toEqual({});
    expect(await (await app.fetch(req("/static/health"))).text()).toEqual("ok");
  });
});

describe("Router 404 / 405", () => {
  it("returns 404 for unknown path", async () => {
    const app = r();
    app.get("/exists").handle(() => new Response("ok"));
    app.build();

    const res = await app.fetch(req("/nope"));
    expect(res.status).toEqual(404);
  });

  it("returns 405 when path matches but method doesn't", async () => {
    const app = r();
    app.get("/items").handle(() => new Response("ok"));
    app.build();

    const res = await app.fetch(req("/items", "DELETE"));
    expect(res.status).toEqual(405);
    expect(res.headers.get("allow")?.includes("GET")).toEqual(true);
  });

  it("custom notFound handler", async () => {
    const app = r();
    app.notFound(() => Response.json({ custom: true }, { status: 404 }));
    app.get("/exists").handle(() => new Response("ok"));
    app.build();

    const res = await app.fetch(req("/missing"));
    expect(res.status).toEqual(404);
    expect((await res.json()).custom).toEqual(true);
  });
});

// ── HEAD auto-handling ─────────────────────────────────────────────────

describe("Router HEAD fallback", () => {
  it("HEAD returns GET response with no body", async () => {
    const app = r();
    app.get("/data").handle(
      () =>
        new Response("payload", {
          headers: { "x-custom": "yes" },
        }),
    );
    app.build();

    const res = await app.fetch(req("/data", "HEAD"));
    expect(res.status).toEqual(200);
    expect(res.headers.get("x-custom")).toEqual("yes");
    expect(await res.text()).toEqual(""); // body stripped
  });

  it("cancels a stripped streaming body", async () => {
    let cancelled = false;
    const app = r();
    app.get("/stream").handle(
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
    );
    app.build();

    await app.fetch(req("/stream", "HEAD"));
    expect(cancelled).toBe(true);
  });
});

describe("serve() HEAD", () => {
  it("reports the GET Content-Length without sending a body", async () => {
    const app = r();
    app.get("/text").handle(() => new Response("payload"));
    app.get("/file").handle(() => new Response(Bun.file(import.meta.path)));
    const server = serve(app, { port: 0, hostname: "127.0.0.1" });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      for (const path of ["/text", "/file"]) {
        const get = await fetch(base + path);
        const head = await fetch(base + path, { method: "HEAD" });
        const length = get.headers.get("content-length");
        expect(Number(length)).toBeGreaterThan(0);
        expect(head.headers.get("content-length")).toBe(length);
        expect(await head.text()).toBe("");
        await get.arrayBuffer();
      }
    } finally {
      await server.stop(true);
    }
  });

  it("does not drain an endless stream to answer HEAD", async () => {
    let pulls = 0;
    const app = r();
    app.get("/endless").handle(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              pulls++;
              controller.enqueue(new TextEncoder().encode("x"));
            },
          }),
        ),
    );
    const server = serve(app, { port: 0, hostname: "127.0.0.1" });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/endless`, {
        method: "HEAD",
        signal: AbortSignal.timeout(2_000),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
      expect(pulls).toBeLessThan(5);
    } finally {
      await server.stop(true);
    }
  });
});

// ── Middleware ──────────────────────────────────────────────────────────

describe("Router middleware", () => {
  it(".use() middleware runs and extends context", async () => {
    const addRole: MiddlewareFn<
      Record<string, unknown>,
      { role: string }
    > = () => ({ role: "admin" });

    const app = r().use(addRole);
    app
      .get("/me")
      .handle(({ ctx }) =>
        Response.json({ role: (ctx as { role: string }).role }),
      );
    app.build();

    const res = await app.fetch(req("/me"));
    expect((await res.json()).role).toEqual("admin");
  });

  it("chained .use() accumulates context", async () => {
    const addA: MiddlewareFn<Record<string, unknown>, { a: number }> = () => ({
      a: 1,
    });
    const addB: MiddlewareFn<{ a: number }, { b: number }> = () => ({ b: 2 });

    const app = r().use(addA).use(addB);
    app.get("/ab").handle(({ ctx }) => Response.json(ctx));
    app.build();

    const res = await app.fetch(req("/ab"));
    const body = await res.json();
    expect(body.a).toEqual(1);
    expect(body.b).toEqual(2);
  });

  it(".use() shares route store — routes on derived router visible to original", async () => {
    const base = r({ prefix: "/api" });
    const withAuth = base.use(() => ({ authed: true }));

    // Register on the original
    base.get("/public").handle(() => new Response("pub"));
    // Register on the .use() result
    withAuth.get("/private").handle(() => new Response("priv"));

    base.build();

    const r1 = await base.fetch(req("/api/public"));
    expect(await r1.text()).toEqual("pub");
    const r2 = await base.fetch(req("/api/private"));
    expect(await r2.text()).toEqual("priv");
  });
});

// ── Sub-routers (extend) ───────────────────────────────────────────────

describe("Router extend()", () => {
  it("child routes are collected by parent build()", async () => {
    const app = r({ prefix: "/api" });
    app.get("/health").handle(() => new Response("ok"));

    const admin = app.extend({ prefix: "/admin" });
    admin.get("/stats").handle(() => new Response("stats"));

    app.build();

    const r1 = await app.fetch(req("/api/health"));
    expect(await r1.text()).toEqual("ok");

    const r2 = await app.fetch(req("/api/admin/stats"));
    expect(await r2.text()).toEqual("stats");
  });

  it("extend().use() — child with added middleware collected by parent", async () => {
    const app = r({ prefix: "/api" });
    app.get("/health").handle(() => new Response("ok"));

    const admin = app
      .extend({ prefix: "/admin" })
      .use(() => ({ isAdmin: true }));

    admin
      .get("/stats")
      .handle(({ ctx }) =>
        Response.json({ admin: (ctx as { isAdmin: boolean }).isAdmin }),
      );

    app.build();

    const r1 = await app.fetch(req("/api/health"));
    expect(await r1.text()).toEqual("ok");

    const r2 = await app.fetch(req("/api/admin/stats"));
    expect((await r2.json()).admin).toEqual(true);
  });

  it("child inherits parent middleware", async () => {
    const addAuth: MiddlewareFn<
      Record<string, unknown>,
      { user: string }
    > = () => ({ user: "alice" });

    const app = r({ prefix: "/api" }).use(addAuth);

    const admin = app.extend({ prefix: "/admin" });
    admin
      .get("/whoami")
      .handle(({ ctx }) =>
        Response.json({ user: (ctx as { user: string }).user }),
      );

    app.build();
    const res = await app.fetch(req("/api/admin/whoami"));
    expect((await res.json()).user).toEqual("alice");
  });
});

// ── Error handling ─────────────────────────────────────────────────────

describe("Router error handling", () => {
  it("route-level .catch() handles errors", async () => {
    const app = r();
    app
      .get("/fail")
      .handle(() => {
        throw new Error("boom");
      })
      .catch((err) => {
        return Response.json(
          { caught: (err as Error).message },
          { status: 500 },
        );
      });
    app.build();

    const res = await app.fetch(req("/fail"));
    expect(res.status).toEqual(500);
    expect((await res.json()).caught).toEqual("boom");
  });

  it("router-level onError catches unhandled route errors", async () => {
    const app = r();
    app.onError((err) =>
      Response.json({ router: (err as Error).message }, { status: 500 }),
    );
    app.get("/fail").handle(() => {
      throw new Error("oops");
    });
    app.build();

    const res = await app.fetch(req("/fail"));
    expect(res.status).toEqual(500);
    expect((await res.json()).router).toEqual("oops");
  });

  it("error chain: route catch → router onError", async () => {
    const order: string[] = [];
    const app = r();
    app.onError(() => {
      order.push("router");
      return Response.json({ level: "router" }, { status: 500 });
    });
    app
      .get("/fail")
      .handle(() => {
        throw new Error("err");
      })
      .catch(() => {
        order.push("route");
        return null; // pass through to next handler
      });
    app.build();

    const res = await app.fetch(req("/fail"));
    expect(order).toEqual(["route", "router"]);
    expect((await res.json()).level).toEqual("router");
  });
});

// ── Build guards ───────────────────────────────────────────────────────

describe("Router build()", () => {
  it("build() is idempotent", () => {
    const app = r();
    app.get("/x").handle(() => new Response("ok"));
    app.build();
    app.build(); // should not throw
  });

  it("fetch throws before build()", async () => {
    const app = r();
    app.get("/x").handle(() => new Response("ok"));

    await expect(app.fetch(req("/x"))).rejects.toThrow("Router not built");
  });

  it("cannot add routes after build()", () => {
    const app = r();
    app.get("/x").handle(() => new Response("ok"));
    app.build();

    try {
      app.get("/y").handle(() => new Response("no"));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toEqual("Cannot add routes after build()");
    }
  });
});

// ── Mounting (add) ─────────────────────────────────────────────────────

describe("Router add()", () => {
  type AuthCtx = { user: string };
  const auth: MiddlewareFn<Record<string, unknown>, AuthCtx> = () => ({
    user: "alice",
  });

  it("mounts a router defined independently, with parent prefix and middleware", async () => {
    const users = r<AuthCtx>({ prefix: "/users" });
    users.get("/me").handle(({ ctx }) => Response.json({ user: ctx.user }));

    const app = r({ prefix: "/api" }).use(auth).add(users);
    app.build();

    const res = await app.fetch(req("/api/users/me"));
    expect(await res.json()).toEqual({ user: "alice" });
  });

  it("add(prefix, ...routers) mounts under an extra prefix", async () => {
    const users = r({ prefix: "/users" });
    users.get("/").handle(() => new Response("list"));
    const posts = r({ prefix: "/posts" });
    posts.get("/").handle(() => new Response("posts"));

    const app = r({ prefix: "/api" }).add("/v1", users, posts);
    app.build();

    expect(await (await app.fetch(req("/api/v1/users/"))).text()).toEqual(
      "list",
    );
    expect(await (await app.fetch(req("/api/v1/posts/"))).text()).toEqual(
      "posts",
    );
  });

  it("the same router can be mounted under several prefixes", async () => {
    const users = r();
    users.get("/users").handle(() => new Response("u"));

    const app = r().add("/v1", users).add("/v2", users);
    app.build();

    expect((await app.fetch(req("/v1/users"))).status).toEqual(200);
    expect((await app.fetch(req("/v2/users"))).status).toEqual(200);
  });

  it("uses the middleware of the variant add() was called on", async () => {
    const order: string[] = [];
    const a: MiddlewareFn<Record<string, unknown>, { a: true }> = () => {
      order.push("a");
      return { a: true };
    };
    const b: MiddlewareFn<{ a: true }, { b: true }> = () => {
      order.push("b");
      return { b: true };
    };
    const child: MiddlewareFn<{ a: true }, { c: true }> = () => {
      order.push("child");
      return { c: true };
    };

    const open = r<{ a: true }>({ prefix: "/open" });
    open.get("/x").handle(() => new Response("ok"));
    const locked = r<{ a: true; b: true }>({ prefix: "/locked" }).use(child);
    locked.get("/x").handle(() => new Response("ok"));

    const base = r().use(a);
    base.add(open);
    base.use(b).add(locked);
    base.build();

    await base.fetch(req("/open/x"));
    expect(order).toEqual(["a"]);
    order.length = 0;
    await base.fetch(req("/locked/x"));
    expect(order).toEqual(["a", "b", "child"]);
  });

  it("nested mounts compose prefixes and middleware", async () => {
    const leaf = r<AuthCtx & { role: string }>({ prefix: "/leaf" });
    leaf
      .get("/")
      .handle(({ ctx }) => Response.json({ user: ctx.user, role: ctx.role }));

    const mid = r<AuthCtx>({ prefix: "/mid" })
      .use(() => ({ role: "admin" }))
      .add(leaf);

    const app = r().use(auth).add("/api", mid);
    app.build();

    const res = await app.fetch(req("/api/mid/leaf/"));
    expect(await res.json()).toEqual({ user: "alice", role: "admin" });
  });

  it("chains child onError before parent onError", async () => {
    const calls: string[] = [];
    const child = r().onError(() => {
      calls.push("child");
      return null;
    });
    child
      .get("/boom")
      .handle(() => {
        throw new Error("boom");
      })
      .catch(() => {
        calls.push("route");
        return null;
      });

    const app = r()
      .onError(() => {
        calls.push("root");
        return new Response("handled", { status: 418 });
      })
      .add(child);
    app.build();

    const res = await app.fetch(req("/boom"));
    expect(res.status).toEqual(418);
    expect(calls).toEqual(["route", "child", "root"]);
  });

  it("routes added to a child after build() throw", () => {
    const child = r();
    const app = r().add(child);
    app.build();
    try {
      child.get("/late").handle(() => new Response("x"));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toEqual("Cannot add routes after build()");
    }
  });

  it("add() after build() throws", () => {
    const app = r();
    app.build();
    try {
      app.add(r());
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toEqual("Cannot add routers after build()");
    }
  });

  it("detects mount cycles", () => {
    const a = r();
    const b = r();
    a.add(b);
    b.add(a);
    try {
      a.build();
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toEqual("Router mount cycle detected");
    }
  });

  it("rejects notFound() on a mounted router", () => {
    const child = r().notFound(() => new Response("nope", { status: 404 }));
    const app = r().add(child);
    try {
      app.build();
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toEqual(
        "cors() and notFound() are only supported on the root router",
      );
    }
  });

  it("type-checks required context", () => {
    const users = r<AuthCtx>();
    const withAuth = r().use(auth);

    withAuth.add(users);
    withAuth.add("/v1", users);
    // @ts-expect-error — parent does not provide `user`
    r().add(users);
    // @ts-expect-error — parent does not provide `user`
    r().add("/v1", users);

    const ctx: CtxOf<typeof withAuth> = { user: "x" };
    void ctx;
    // serve() only accepts routers with no outstanding requirements
    const _ok: Parameters<typeof serve>[0] = withAuth;
    // @ts-expect-error — users requires AuthCtx
    const _bad: Parameters<typeof serve>[0] = users;
  });
});

describe("serve() error hook", () => {
  it("returns a bare 500 and logs when the response body fails to open", async () => {
    const missing = `${import.meta.dir}/__does-not-exist__.txt`;
    const app = r();
    app.get("/file").handle(() => new Response(Bun.file(missing)));

    const logged: unknown[][] = [];
    const server = serve(app, {
      port: 0,
      hostname: "127.0.0.1",
      development: true,
      logger: {
        error: (...args) => void logged.push(args),
        warn: () => {},
        info: () => {},
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/file`);
      const body = await res.text();
      expect(res.status).toBe(500);
      expect(body).toBe("");
      expect(logged).toHaveLength(1);
    } finally {
      await server.stop(true);
    }
  });
});

// ── Route guards & onBuild hooks (used by optional modules like ws) ────

describe("route guards", () => {
  it("run before router-level middleware and can reject", async () => {
    const order: string[] = [];
    const app = r().use(() => {
      order.push("middleware");
      return {};
    });
    const route = app.get("/g").handle(() => new Response("ok"));
    route.definition.guards = [
      (req) => {
        order.push("guard");
        if (req.headers.get("x-deny")) throw new ForbiddenError();
      },
    ];
    app.build();

    const ok = await app.fetch(req("/g"));
    expect(ok.status).toEqual(200);
    expect(order).toEqual(["guard", "middleware"]);

    order.length = 0;
    const denied = await app.fetch(
      new Request(`${BASE}/g`, { headers: { "x-deny": "1" } }),
    );
    expect(denied.status).toEqual(403);
    expect(order).toEqual(["guard"]);
  });

  it("still run first when the route lives on a mounted child", async () => {
    const order: string[] = [];
    const parent = r().use(() => {
      order.push("parent-mw");
      return {};
    });
    const child = r({ prefix: "/c" });
    const route = child.get("/x").handle(() => new Response("ok"));
    route.definition.guards = [() => void order.push("guard")];
    parent.add(child);
    parent.build();

    await parent.fetch(req("/c/x"));
    expect(order).toEqual(["guard", "parent-mw"]);
  });
});

describe("onBuild hook", () => {
  it("receives root cors options and serve env", () => {
    const app = r().cors({ origin: ["https://a.test"] });
    const child = r();
    let env: unknown;
    const route = child.get("/x").handle(() => new Response("ok"));
    route.definition.onBuild = (e) => {
      env = e;
    };
    app.add(child);
    app._setEnv({ development: true, websocket: { idleTimeout: 5 } });
    app.build();

    expect(env).toMatchObject({
      cors: { origin: ["https://a.test"] },
      development: true,
      websocket: { idleTimeout: 5 },
    });
  });

  it("defaults to no cors, production, empty websocket options", () => {
    const app = r();
    let env: unknown;
    app.get("/x").handle(() => new Response("ok")).definition.onBuild = (e) => {
      env = e;
    };
    app.build();
    expect(env).toMatchObject({
      cors: null,
      development: false,
      websocket: {},
    });
  });
});
