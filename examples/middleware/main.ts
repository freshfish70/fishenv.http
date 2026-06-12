/**
 * Middleware — Context Extension, Auth Guard, Interceptors
 *
 * Shows how .use() builds typed context through the middleware chain,
 * sub-routers with additional middleware via extend().use(),
 * route-level middleware with .with(), and interceptors for timing.
 *
 * Run: deno run --allow-net examples/middleware/main.ts
 *
 * Try:
 *   curl localhost:3002/api/health
 *   curl localhost:3002/api/me -H "Authorization: Bearer tok_alice"
 *   curl localhost:3002/api/me                                        # → 401
 *   curl localhost:3002/api/admin/users -H "Authorization: Bearer tok_alice"
 *   curl -i localhost:3002/api/slow -H "Authorization: Bearer tok_alice"
 */
import { ForbiddenError, r, serve, UnauthorizedError } from "@fishenv/http";
import type { MiddlewareFn } from "@fishenv/http";

// ── Middleware definitions ──────────────────────────────────────────────

const RequestId: MiddlewareFn<
  Record<string, unknown>,
  { requestId: string }
> = () => ({
  requestId: crypto.randomUUID(),
});

const Auth: MiddlewareFn<
  Record<string, unknown>,
  { user: { id: string; name: string } }
> = ({ req }) => {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  console.log(req.headers);
  if (!token) throw new UnauthorizedError();
  // In production you'd verify the JWT / lookup the session here
  return { user: { id: "u_1", name: "Alice" } };
};

const AdminGuard: MiddlewareFn<
  { user: { id: string; name: string } },
  { isAdmin: boolean }
> = ({ user }) => {
  if (user.id !== "u_1") throw new ForbiddenError("Admin access required");
  return { isAdmin: true };
};

// ── Router setup ───────────────────────────────────────────────────────

// All routes get a request ID
const app = r({ prefix: "/api" }).use(RequestId);

// Public — no auth required
app.get("/health").handle(({ ctx }) =>
  Response.json({ ok: true, requestId: ctx.requestId })
);

// Authenticated section — extend() + .use(Auth) adds auth to all child routes
const authed = app.extend().use(Auth);

authed.get("/me").handle(({ ctx }) =>
  Response.json({ user: ctx.user, requestId: ctx.requestId })
);

// Route-level middleware with .with() — only this route gets viewedAt
authed.get("/profile")
  .with(() => ({ viewedAt: new Date().toISOString() }))
  .handle(({ ctx }) =>
    Response.json({ user: ctx.user, viewedAt: ctx.viewedAt })
  );

// Admin section — another extend().use() layer on top of authed
const admin = authed.extend({ prefix: "/admin" }).use(AdminGuard);

admin.get("/users").handle(({ ctx }) =>
  Response.json({
    requestedBy: ctx.user.name,
    isAdmin: ctx.isAdmin,
    users: [
      { id: "u_1", name: "Alice" },
      { id: "u_2", name: "Bob" },
    ],
  })
);

// ── Interceptors — request timing ──────────────────────────────────────

authed.get("/slow")
  .intercept(
    ({ state }) => {
      state.start = performance.now();
    },
    ({ response, state }) => {
      const ms = (performance.now() - (state.start as number)).toFixed(2);
      response.headers.set("x-response-time", `${ms}ms`);
      return response;
    },
  )
  .handle(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return Response.json({ data: "done" });
  });

serve(app, {
  port: 3002,
  onListen: ({ hostname, port }) =>
    console.log(`Middleware server running at http://${hostname}:${port}`),
});
