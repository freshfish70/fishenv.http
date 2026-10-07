import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { type CtxOf, r, Router, type serve } from "./router.ts";
import type { MiddlewareFn } from "./types.ts";

const BASE = "http://localhost";

function req(path: string, method = "GET"): Request {
  return new Request(`${BASE}${path}`, { method });
}

// ── Factories ──────────────────────────────────────────────────────────

describe("r() factory", () => {
  it("creates a Router instance", () => {
    const app = r();
    assertEquals(app instanceof Router, true);
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
    assertEquals(res.status, 200);
    assertEquals(await res.text(), "world");
  });

  it("POST route works", async () => {
    const app = r();
    app.post("/items").handle(() => new Response("created", { status: 201 }));
    app.build();

    const res = await app.fetch(req("/items", "POST"));
    assertEquals(res.status, 201);
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
      assertEquals(await res.text(), m);
    }
  });

  it("path params extracted", async () => {
    const app = r();
    app.get("/users/:id").handle(({ path }) => Response.json(path));
    app.build();

    const res = await app.fetch(req("/users/42"));
    assertEquals(await res.json(), { id: "42" });
  });

  it("prefix is prepended to route paths", async () => {
    const app = r({ prefix: "/api" });
    app.get("/health").handle(() => new Response("ok"));
    app.build();

    const res = await app.fetch(req("/api/health"));
    assertEquals(res.status, 200);
    assertEquals(await res.text(), "ok");
  });
});

// ── 404 / 405 ──────────────────────────────────────────────────────────

describe("Router 404 / 405", () => {
  it("returns 404 for unknown path", async () => {
    const app = r();
    app.get("/exists").handle(() => new Response("ok"));
    app.build();

    const res = await app.fetch(req("/nope"));
    assertEquals(res.status, 404);
  });

  it("returns 405 when path matches but method doesn't", async () => {
    const app = r();
    app.get("/items").handle(() => new Response("ok"));
    app.build();

    const res = await app.fetch(req("/items", "DELETE"));
    assertEquals(res.status, 405);
    assertEquals(res.headers.get("allow")?.includes("GET"), true);
  });

  it("custom notFound handler", async () => {
    const app = r();
    app.notFound(() => Response.json({ custom: true }, { status: 404 }));
    app.get("/exists").handle(() => new Response("ok"));
    app.build();

    const res = await app.fetch(req("/missing"));
    assertEquals(res.status, 404);
    assertEquals((await res.json()).custom, true);
  });
});

// ── HEAD auto-handling ─────────────────────────────────────────────────

describe("Router HEAD fallback", () => {
  it("HEAD returns GET response with no body", async () => {
    const app = r();
    app.get("/data").handle(() =>
      new Response("payload", {
        headers: { "x-custom": "yes" },
      })
    );
    app.build();

    const res = await app.fetch(req("/data", "HEAD"));
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("x-custom"), "yes");
    assertEquals(await res.text(), ""); // body stripped
  });
});

// ── Middleware ──────────────────────────────────────────────────────────

describe("Router middleware", () => {
  it(".use() middleware runs and extends context", async () => {
    const addRole: MiddlewareFn<Record<string, unknown>, { role: string }> =
      () => ({ role: "admin" });

    const app = r().use(addRole);
    app.get("/me").handle(({ ctx }) =>
      Response.json({ role: (ctx as { role: string }).role })
    );
    app.build();

    const res = await app.fetch(req("/me"));
    assertEquals((await res.json()).role, "admin");
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
    assertEquals(body.a, 1);
    assertEquals(body.b, 2);
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
    assertEquals(await r1.text(), "pub");
    const r2 = await base.fetch(req("/api/private"));
    assertEquals(await r2.text(), "priv");
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
    assertEquals(await r1.text(), "ok");

    const r2 = await app.fetch(req("/api/admin/stats"));
    assertEquals(await r2.text(), "stats");
  });

  it("extend().use() — child with added middleware collected by parent", async () => {
    const app = r({ prefix: "/api" });
    app.get("/health").handle(() => new Response("ok"));

    const admin = app.extend({ prefix: "/admin" })
      .use(() => ({ isAdmin: true }));

    admin.get("/stats").handle(({ ctx }) =>
      Response.json({ admin: (ctx as { isAdmin: boolean }).isAdmin })
    );

    app.build();

    const r1 = await app.fetch(req("/api/health"));
    assertEquals(await r1.text(), "ok");

    const r2 = await app.fetch(req("/api/admin/stats"));
    assertEquals((await r2.json()).admin, true);
  });

  it("child inherits parent middleware", async () => {
    const addAuth: MiddlewareFn<Record<string, unknown>, { user: string }> =
      () => ({ user: "alice" });

    const app = r({ prefix: "/api" }).use(addAuth);

    const admin = app.extend({ prefix: "/admin" });
    admin.get("/whoami").handle(({ ctx }) =>
      Response.json({ user: (ctx as { user: string }).user })
    );

    app.build();
    const res = await app.fetch(req("/api/admin/whoami"));
    assertEquals((await res.json()).user, "alice");
  });
});

// ── Error handling ─────────────────────────────────────────────────────

describe("Router error handling", () => {
  it("route-level .catch() handles errors", async () => {
    const app = r();
    app.get("/fail").handle(() => {
      throw new Error("boom");
    }).catch((err) => {
      return Response.json(
        { caught: (err as Error).message },
        { status: 500 },
      );
    });
    app.build();

    const res = await app.fetch(req("/fail"));
    assertEquals(res.status, 500);
    assertEquals((await res.json()).caught, "boom");
  });

  it("router-level onError catches unhandled route errors", async () => {
    const app = r();
    app.onError((err) =>
      Response.json({ router: (err as Error).message }, { status: 500 })
    );
    app.get("/fail").handle(() => {
      throw new Error("oops");
    });
    app.build();

    const res = await app.fetch(req("/fail"));
    assertEquals(res.status, 500);
    assertEquals((await res.json()).router, "oops");
  });

  it("error chain: route catch → router onError", async () => {
    const order: string[] = [];
    const app = r();
    app.onError(() => {
      order.push("router");
      return Response.json({ level: "router" }, { status: 500 });
    });
    app.get("/fail").handle(() => {
      throw new Error("err");
    }).catch(() => {
      order.push("route");
      return null; // pass through to next handler
    });
    app.build();

    const res = await app.fetch(req("/fail"));
    assertEquals(order, ["route", "router"]);
    assertEquals((await res.json()).level, "router");
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

    await assertRejects(
      () => app.fetch(req("/x")),
      Error,
      "Router not built",
    );
  });

  it("cannot add routes after build()", () => {
    const app = r();
    app.get("/x").handle(() => new Response("ok"));
    app.build();

    try {
      app.get("/y").handle(() => new Response("no"));
      throw new Error("should have thrown");
    } catch (e) {
      assertEquals((e as Error).message, "Cannot add routes after build()");
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
    assertEquals(await res.json(), { user: "alice" });
  });

  it("add(prefix, ...routers) mounts under an extra prefix", async () => {
    const users = r({ prefix: "/users" });
    users.get("/").handle(() => new Response("list"));
    const posts = r({ prefix: "/posts" });
    posts.get("/").handle(() => new Response("posts"));

    const app = r({ prefix: "/api" }).add("/v1", users, posts);
    app.build();

    assertEquals(await (await app.fetch(req("/api/v1/users/"))).text(), "list");
    assertEquals(
      await (await app.fetch(req("/api/v1/posts/"))).text(),
      "posts",
    );
  });

  it("the same router can be mounted under several prefixes", async () => {
    const users = r();
    users.get("/users").handle(() => new Response("u"));

    const app = r().add("/v1", users).add("/v2", users);
    app.build();

    assertEquals((await app.fetch(req("/v1/users"))).status, 200);
    assertEquals((await app.fetch(req("/v2/users"))).status, 200);
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
    assertEquals(order, ["a"]);
    order.length = 0;
    await base.fetch(req("/locked/x"));
    assertEquals(order, ["a", "b", "child"]);
  });

  it("nested mounts compose prefixes and middleware", async () => {
    const leaf = r<AuthCtx & { role: string }>({ prefix: "/leaf" });
    leaf.get("/").handle(({ ctx }) =>
      Response.json({ user: ctx.user, role: ctx.role })
    );

    const mid = r<AuthCtx>({ prefix: "/mid" })
      .use(() => ({ role: "admin" }))
      .add(leaf);

    const app = r().use(auth).add("/api", mid);
    app.build();

    const res = await app.fetch(req("/api/mid/leaf/"));
    assertEquals(await res.json(), { user: "alice", role: "admin" });
  });

  it("chains child onError before parent onError", async () => {
    const calls: string[] = [];
    const child = r().onError(() => {
      calls.push("child");
      return null;
    });
    child.get("/boom").handle(() => {
      throw new Error("boom");
    }).catch(() => {
      calls.push("route");
      return null;
    });

    const app = r().onError(() => {
      calls.push("root");
      return new Response("handled", { status: 418 });
    }).add(child);
    app.build();

    const res = await app.fetch(req("/boom"));
    assertEquals(res.status, 418);
    assertEquals(calls, ["route", "child", "root"]);
  });

  it("routes added to a child after build() throw", () => {
    const child = r();
    const app = r().add(child);
    app.build();
    try {
      child.get("/late").handle(() => new Response("x"));
      throw new Error("should have thrown");
    } catch (e) {
      assertEquals((e as Error).message, "Cannot add routes after build()");
    }
  });

  it("add() after build() throws", () => {
    const app = r();
    app.build();
    try {
      app.add(r());
      throw new Error("should have thrown");
    } catch (e) {
      assertEquals((e as Error).message, "Cannot add routers after build()");
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
      assertEquals((e as Error).message, "Router mount cycle detected");
    }
  });

  it("rejects notFound() on a mounted router", () => {
    const child = r().notFound(() => new Response("nope", { status: 404 }));
    const app = r().add(child);
    try {
      app.build();
      throw new Error("should have thrown");
    } catch (e) {
      assertEquals(
        (e as Error).message,
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
