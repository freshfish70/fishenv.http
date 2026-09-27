import { assertEquals } from "@std/assert";
import { assertType, type IsExact } from "@std/testing/types";
import * as v from "valibot";
import { c } from "@fishenv/http-contract";
import { r } from "./router.ts";

const BASE = "http://localhost";

function req(
  path: string,
  init: RequestInit & { method: string } = { method: "GET" },
): Request {
  return new Request(`${BASE}${path}`, init);
}

const CreateUserSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  email: v.pipe(v.string(), v.email()),
});

const UserOutputSchema = v.object({
  id: v.string(),
  name: v.string(),
  email: v.string(),
});

const NumericId = v.pipe(v.string(), v.transform(Number), v.number());

const usersContract = {
  create: c
    .post("/users")
    .input("json", { body: CreateUserSchema })
    .output(UserOutputSchema),
  get: c.get("/users/:id").param("id", NumericId).output(UserOutputSchema),
};

Deno.test(
  "router.contract() — registers a route matching the contract",
  async () => {
    const app = r();

    app.contract(usersContract.create).handle(({ body }) => {
      assertType<IsExact<typeof body, { name: string; email: string }>>(true);
      return { id: "u1", ...body };
    });

    app.build();

    const res = await app.fetch(
      req("/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Alice", email: "alice@example.com" }),
      }),
    );

    assertEquals(res.status, 200);
    assertEquals(await res.json(), {
      id: "u1",
      name: "Alice",
      email: "alice@example.com",
    });
  },
);

Deno.test("router.contract() — path param schema is coerced", async () => {
  const app = r();

  app.contract(usersContract.get).handle(({ path }) => {
    assertType<IsExact<typeof path, { id: number }>>(true);
    return { id: String(path.id), name: "Bob", email: "bob@example.com" };
  });

  app.build();

  const res = await app.fetch(req("/users/42"));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    id: "42",
    name: "Bob",
    email: "bob@example.com",
  });
});

Deno.test(
  "router.contract() — invalid body is rejected per contract schema",
  async () => {
    const app = r();
    app.contract(usersContract.create).handle(({ body }) => ({
      id: "u1",
      ...body,
    }));
    app.build();

    const res = await app.fetch(
      req("/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "", email: "not-an-email" }),
      }),
    );

    assertEquals(res.status, 400);
  },
);

Deno.test(
  "router.contract() — still supports .catch() and router prefix",
  async () => {
    const app = r({ prefix: "/api" });
    app
      .contract(usersContract.get)
      .handle(() => {
        throw new Error("boom");
      })
      .catch(
        (_err, { req }) =>
          new Response(`caught:${new URL(req.url).pathname}`, { status: 500 }),
      );
    app.build();

    const res = await app.fetch(req("/api/users/1"));
    assertEquals(res.status, 500);
    assertEquals(await res.text(), "caught:/api/users/1");
  },
);
