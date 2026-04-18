/**
 * Validation — Valibot Schemas for Input & Params
 *
 * Shows body validation, query validation, path param coercion,
 * and how ValidationError responses look.
 *
 * Run: deno run --allow-net examples/validation/main.ts
 *
 * Try:
 *   curl localhost:3003/api/users -X POST -H "Content-Type: application/json" \
 *     -d '{"name":"Alice","email":"alice@example.com"}'
 *
 *   curl localhost:3003/api/users -X POST -H "Content-Type: application/json" \
 *     -d '{"name":"","email":"not-an-email"}'                                     # → 400
 *
 *   curl "localhost:3003/api/users?page=2&limit=20"
 *   curl "localhost:3003/api/users?page=abc"                                       # → 400
 *
 *   curl localhost:3003/api/users/42
 *   curl localhost:3003/api/users/not-a-number                                     # → 400
 */
import { r, serve } from "@fishenv/http";
import * as v from "valibot";

const app = r({ prefix: "/api" });

// ── Body validation ────────────────────────────────────────────────────

const CreateUserSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1, "Name is required")),
  email: v.pipe(v.string(), v.email("Invalid email")),
  age: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(150))),
});

app.post("/users")
  .input("json", { body: CreateUserSchema })
  .handle(({ body }) => {
    // body is typed as { name: string; email: string; age?: number }
    return Response.json(
      { id: crypto.randomUUID(), ...body, createdAt: new Date().toISOString() },
      { status: 201 },
    );
  });

// ── Query validation ───────────────────────────────────────────────────

const PaginationSchema = v.object({
  page: v.optional(v.pipe(v.string(), v.transform(Number), v.minValue(1)), "1"),
  limit: v.optional(v.pipe(v.string(), v.transform(Number), v.minValue(1), v.maxValue(100)), "20"),
});

app.get("/users")
  .input("none", { query: PaginationSchema })
  .handle(({ query }) => {
    // query is typed as { page: number; limit: number }
    const users = Array.from({ length: query.limit }, (_, i) => ({
      id: (query.page - 1) * query.limit + i + 1,
      name: `User ${(query.page - 1) * query.limit + i + 1}`,
    }));
    return Response.json({ page: query.page, limit: query.limit, users });
  });

// ── Path param coercion ────────────────────────────────────────────────

const NumericId = v.pipe(
  v.string(),
  v.transform(Number),
  v.number("ID must be numeric"),
  v.integer("ID must be an integer"),
  v.minValue(1, "ID must be positive"),
);

app.get("/users/:id")
  .param("id", NumericId)
  .handle(({ path }) => {
    // path.id is typed as number (coerced from string)
    return Response.json({ id: path.id, name: `User ${path.id}` });
  });

// ── Output schema (auto-serializes plain objects to JSON) ──────────────

const UserOutputSchema = v.object({
  id: v.number(),
  name: v.string(),
  email: v.string(),
});

app.get("/users/:id/profile")
  .param("id", NumericId)
  .output(UserOutputSchema)
  .handle(({ path }) =>
    // Can return a plain object — coerced to Response.json() automatically
    ({ id: path.id, name: `User ${path.id}`, email: `user${path.id}@example.com` })
  );

serve(app, {
  port: 3003,
  onListen: ({ hostname, port }) =>
    console.log(`Validation server running at http://${hostname}:${port}`),
});
