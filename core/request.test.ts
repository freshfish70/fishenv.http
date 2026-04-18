import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import * as v from "valibot";
import {
  extractHeaders,
  extractQuery,
  parseBody,
  parseCookies,
  parseInput,
} from "./request.ts";
import { validateField, validatePathParams } from "./validation.ts";
import { BadRequestError, HttpError, ValidationError } from "./error.ts";
import type { RouteDefinition } from "./types.ts";

const BASE = "http://localhost";

// ── parseCookies ───────────────────────────────────────────────────────

describe("parseCookies", () => {
  it("parses single cookie", () => {
    const req = new Request(BASE, {
      headers: { cookie: "session=abc123" },
    });
    assertEquals(parseCookies(req), { session: "abc123" });
  });

  it("parses multiple cookies", () => {
    const req = new Request(BASE, {
      headers: { cookie: "a=1; b=2; c=3" },
    });
    assertEquals(parseCookies(req), { a: "1", b: "2", c: "3" });
  });

  it("handles URL-encoded values", () => {
    const req = new Request(BASE, {
      headers: { cookie: "name=hello%20world" },
    });
    assertEquals(parseCookies(req), { name: "hello world" });
  });

  it("handles values with equals signs", () => {
    const req = new Request(BASE, {
      headers: { cookie: "token=abc=def=ghi" },
    });
    assertEquals(parseCookies(req), { token: "abc=def=ghi" });
  });

  it("returns empty object for no cookie header", () => {
    const req = new Request(BASE);
    assertEquals(parseCookies(req), {});
  });
});

// ── extractHeaders ─────────────────────────────────────────────────────

describe("extractHeaders", () => {
  it("extracts all headers lowercased", () => {
    const req = new Request(BASE, {
      headers: { "Content-Type": "application/json", "X-Custom": "val" },
    });
    const h = extractHeaders(req);
    assertEquals(h["content-type"], "application/json");
    assertEquals(h["x-custom"], "val");
  });
});

// ── extractQuery ───────────────────────────────────────────────────────

describe("extractQuery", () => {
  it("extracts single-value params", () => {
    const req = new Request(`${BASE}?foo=bar&baz=qux`);
    assertEquals(extractQuery(req), { foo: "bar", baz: "qux" });
  });

  it("duplicates become arrays", () => {
    const req = new Request(`${BASE}?tag=a&tag=b&tag=c`);
    assertEquals(extractQuery(req), { tag: ["a", "b", "c"] });
  });

  it("returns empty for no query string", () => {
    const req = new Request(BASE);
    assertEquals(extractQuery(req), {});
  });
});

// ── parseBody ──────────────────────────────────────────────────────────

describe("parseBody", () => {
  it("json — parses valid JSON", async () => {
    const req = new Request(BASE, {
      method: "POST",
      body: JSON.stringify({ x: 1 }),
      headers: { "content-type": "application/json" },
    });
    const body = await parseBody(req, "json", {});
    assertEquals(body, { x: 1 });
  });

  it("json — throws BadRequestError on invalid JSON", async () => {
    const req = new Request(BASE, {
      method: "POST",
      body: "{broken",
      headers: { "content-type": "application/json" },
    });
    await assertRejects(
      () => parseBody(req, "json", {}),
      BadRequestError,
      "Invalid JSON",
    );
  });

  it("text — returns string", async () => {
    const req = new Request(BASE, {
      method: "POST",
      body: "hello world",
    });
    const body = await parseBody(req, "text", {});
    assertEquals(body, "hello world");
  });

  it("blob — returns Blob", async () => {
    const req = new Request(BASE, {
      method: "POST",
      body: new Blob(["data"]),
    });
    const body = await parseBody(req, "blob", {});
    assertEquals(body instanceof Blob, true);
  });

  it("none — returns undefined", async () => {
    const req = new Request(BASE);
    const body = await parseBody(req, "none", {});
    assertEquals(body, undefined);
  });

  it("enforces maxSize via content-length", async () => {
    const bigBody = "x".repeat(1000);
    const req = new Request(BASE, {
      method: "POST",
      body: bigBody,
      headers: { "content-length": "1000" },
    });
    await assertRejects(
      () => parseBody(req, "blob", { maxSize: 100 } as Record<string, unknown>),
      HttpError,
      "Payload Too Large",
    );
  });
});

// ── validateField ──────────────────────────────────────────────────────

describe("validateField", () => {
  it("returns validated output", () => {
    const schema = v.object({ name: v.string() });
    const result = validateField(schema, { name: "test" }, "body");
    assertEquals(result, { name: "test" });
  });

  it("throws ValidationError on failure", () => {
    const schema = v.object({ name: v.string() });
    try {
      validateField(schema, { name: 123 }, "body");
      throw new Error("should have thrown");
    } catch (e) {
      assertEquals(e instanceof ValidationError, true);
      assertEquals((e as ValidationError).field, "body");
      assertEquals((e as ValidationError).status, 400);
    }
  });
});

// ── validatePathParams ─────────────────────────────────────────────────

describe("validatePathParams", () => {
  it("coerces params with schemas", () => {
    const schemas = new Map([
      ["id", v.pipe(v.string(), v.transform(Number))],
    ]);
    const result = validatePathParams({ id: "42", slug: "hello" }, schemas);
    assertEquals(result, { id: 42, slug: "hello" });
  });

  it("passes through params without schemas", () => {
    const result = validatePathParams({ name: "alice" }, new Map());
    assertEquals(result, { name: "alice" });
  });
});

// ── ValidationError response shape ────────────────────────────────────

describe("ValidationError", () => {
  it("toResponse returns structured JSON", async () => {
    const schema = v.object({ email: v.pipe(v.string(), v.email()) });
    try {
      validateField(schema, { email: "nope" }, "body");
    } catch (e) {
      const res = (e as ValidationError).toResponse();
      assertEquals(res.status, 400);
      const body = await res.json();
      assertEquals(body.error, "ValidationError");
      assertEquals(body.field, "body");
      assertEquals(body.issues.length > 0, true);
      assertEquals(typeof body.issues[0].message, "string");
    }
  });
});

// ── parseInput integration ─────────────────────────────────────────────

describe("parseInput", () => {
  it("parses JSON body + query + cookies + headers + path params", async () => {
    const req = new Request(`${BASE}/users/42?page=1`, {
      method: "POST",
      body: JSON.stringify({ name: "alice" }),
      headers: {
        "content-type": "application/json",
        "cookie": "session=xyz",
        "x-request-id": "req-1",
      },
    });

    const def: RouteDefinition = {
      method: "POST",
      path: "/users/:id",
      middlewares: [],
      paramSchemas: new Map(),
      inputKind: "json",
      inputOptions: {},
      interceptors: [],
      handler: () => new Response(),
      kind: "http",
    };

    const input = await parseInput(req, def, { id: "42" });
    assertEquals(input.body, { name: "alice" });
    assertEquals(input.path, { id: "42" });
    assertEquals(input.query, { page: "1" });
    assertEquals(input.cookies, { session: "xyz" });
    assertEquals(input.headers["x-request-id"], "req-1");
  });
});
