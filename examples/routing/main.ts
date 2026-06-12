/**
 * Routing — Paths, Params, Sub-Routers
 *
 * Demonstrates path parameters, multiple HTTP methods,
 * query strings, prefixes, and sub-routers via .extend().
 *
 * Run: deno run --allow-net examples/routing/main.ts
 */
import { r, serve } from "@fishenv/http";

const app = r({ prefix: "/api" });

// ── Path parameters ────────────────────────────────────────────────────

// Single param  →  GET /api/users/42
app.get("/users/:id").handle(({ path }) => Response.json({ userId: path.id }));

// Multiple params  →  GET /api/orgs/acme/repos/http
app.get("/orgs/:org/repos/:repo").handle(({ path }) =>
  Response.json({ org: path.org, repo: path.repo })
);

// ── Query parameters ───────────────────────────────────────────────────

// GET /api/search?q=hello&limit=10
app.get("/search").handle(({ query }) =>
  Response.json({ query: query.q, limit: query.limit })
);

// ── Multiple methods on the same resource ──────────────────────────────

// GET /api/posts       → list
app.get("/posts").handle(() =>
  Response.json([
    { id: 1, title: "First post" },
    { id: 2, title: "Second post" },
  ])
);

// POST /api/posts      → create
app.post("/posts").handle(async ({ req }) => {
  const body = await req.json();
  return Response.json({ id: 3, ...body }, { status: 201 });
});

// GET /api/posts/:id   → read
app.get("/posts/:id").handle(({ path }) =>
  Response.json({ id: path.id, title: "A post" })
);

// PUT /api/posts/:id   → update
app.put("/posts/:id").handle(({ path }) =>
  Response.json({ id: path.id, updated: true })
);

// DELETE /api/posts/:id → delete
app.delete("/posts/:id").handle(({ path }) =>
  new Response(null, { status: 204 })
);

// ── Sub-routers with .extend() ─────────────────────────────────────────

const admin = app.extend({ prefix: "/admin" });

// GET /api/admin/dashboard
admin.get("/dashboard").handle(() =>
  Response.json({ users: 142, activeNow: 7 })
);

// GET /api/admin/settings
admin.get("/settings").handle(() =>
  Response.json({ maintenance: false, maxUpload: "10MB" })
);

// ── Custom 404 ─────────────────────────────────────────────────────────

app.notFound((req) =>
  Response.json(
    { error: "Not Found!!!!!!!!!!", path: new URL(req.url).pathname },
    { status: 404 },
  )
);

serve(app, {
  port: 3002,
  onListen: ({ hostname, port }) =>
    console.log(`Routing server running at http://${hostname}:${port}`),
});
