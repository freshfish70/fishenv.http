import { describe, expect, it } from "bun:test";
import * as v from "valibot";
import { BadRequestError, HttpError, ValidationError } from "./error.ts";
import {
  extractHeaders,
  extractQuery,
  parseBody,
  parseCookies,
  parseInput,
} from "./request.ts";
import type { RouteDefinition } from "./types.ts";
import { validateField, validatePathParams } from "./validation.ts";

const BASE = "http://localhost";

// ── parseCookies ───────────────────────────────────────────────────────

describe("parseCookies", () => {
  it("parses single cookie", () => {
    const req = new Request(BASE, {
      headers: { cookie: "session=abc123" },
    });
    expect(parseCookies(req)).toEqual({ session: "abc123" });
  });

  it("parses multiple cookies", () => {
    const req = new Request(BASE, {
      headers: { cookie: "a=1; b=2; c=3" },
    });
    expect(parseCookies(req)).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("handles URL-encoded values", () => {
    const req = new Request(BASE, {
      headers: { cookie: "name=hello%20world" },
    });
    expect(parseCookies(req)).toEqual({ name: "hello world" });
  });

  it("handles values with equals signs", () => {
    const req = new Request(BASE, {
      headers: { cookie: "token=abc=def=ghi" },
    });
    expect(parseCookies(req)).toEqual({ token: "abc=def=ghi" });
  });

  it("returns empty object for no cookie header", () => {
    const req = new Request(BASE);
    expect(parseCookies(req)).toEqual({});
  });
});

// ── extractHeaders ─────────────────────────────────────────────────────

describe("extractHeaders", () => {
  it("extracts all headers lowercased", () => {
    const req = new Request(BASE, {
      headers: { "Content-Type": "application/json", "X-Custom": "val" },
    });
    const h = extractHeaders(req);
    expect(h["content-type"]).toEqual("application/json");
    expect(h["x-custom"]).toEqual("val");
  });
});

// ── extractQuery ───────────────────────────────────────────────────────

describe("extractQuery", () => {
  it("extracts single-value params", () => {
    const req = new Request(`${BASE}?foo=bar&baz=qux`);
    expect(extractQuery(req)).toEqual({ foo: "bar", baz: "qux" });
  });

  it("duplicates become arrays", () => {
    const req = new Request(`${BASE}?tag=a&tag=b&tag=c`);
    expect(extractQuery(req)).toEqual({ tag: ["a", "b", "c"] });
  });

  it("returns empty for no query string", () => {
    const req = new Request(BASE);
    expect(extractQuery(req)).toEqual({});
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
    expect(body).toEqual({ x: 1 });
  });

  it("json — throws BadRequestError on invalid JSON", async () => {
    const req = new Request(BASE, {
      method: "POST",
      body: "{broken",
      headers: { "content-type": "application/json" },
    });
    const result = parseBody(req, "json", {});
    await expect(result).rejects.toBeInstanceOf(BadRequestError);
    await expect(result).rejects.toThrow("Invalid JSON");
  });

  it("text — returns string", async () => {
    const req = new Request(BASE, {
      method: "POST",
      body: "hello world",
    });
    const body = await parseBody(req, "text", {});
    expect(body).toEqual("hello world");
  });

  it("blob — returns Blob", async () => {
    const req = new Request(BASE, {
      method: "POST",
      body: new Blob(["data"]),
    });
    const body = await parseBody(req, "blob", {});
    expect(body instanceof Blob).toEqual(true);
  });

  it("none — returns undefined", async () => {
    const req = new Request(BASE);
    const body = await parseBody(req, "none", {});
    expect(body).toEqual(undefined);
  });

  it("enforces maxSize via content-length", async () => {
    const bigBody = "x".repeat(1000);
    const req = new Request(BASE, {
      method: "POST",
      body: bigBody,
      headers: { "content-length": "1000" },
    });
    const result = parseBody(req, "blob", { maxSize: 100 } as Record<
      string,
      unknown
    >);
    await expect(result).rejects.toBeInstanceOf(HttpError);
    await expect(result).rejects.toThrow("Payload Too Large");
  });
});

// ── validateField ──────────────────────────────────────────────────────

describe("validateField", () => {
  it("returns validated output", () => {
    const schema = v.object({ name: v.string() });
    const result = validateField(schema, { name: "test" }, "body");
    expect(result).toEqual({ name: "test" });
  });

  it("throws ValidationError on failure", () => {
    const schema = v.object({ name: v.string() });
    try {
      validateField(schema, { name: 123 }, "body");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e instanceof ValidationError).toEqual(true);
      expect((e as ValidationError).field).toEqual("body");
      expect((e as ValidationError).status).toEqual(400);
    }
  });
});

// ── validatePathParams ─────────────────────────────────────────────────

describe("validatePathParams", () => {
  it("coerces params with schemas", () => {
    const schemas = new Map([["id", v.pipe(v.string(), v.transform(Number))]]);
    const result = validatePathParams({ id: "42", slug: "hello" }, schemas);
    expect(result).toEqual({ id: 42, slug: "hello" });
  });

  it("passes through params without schemas", () => {
    const result = validatePathParams({ name: "alice" }, new Map());
    expect(result).toEqual({ name: "alice" });
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
      expect(res.status).toEqual(400);
      const body = await res.json();
      expect(body.error).toEqual("ValidationError");
      expect(body.field).toEqual("body");
      expect(body.issues.length > 0).toEqual(true);
      expect(typeof body.issues[0].message).toEqual("string");
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
        cookie: "session=xyz",
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
    expect(input.body).toEqual({ name: "alice" });
    expect(input.path).toEqual({ id: "42" });
    expect(input.query).toEqual({ page: "1" });
    expect(input.cookies).toEqual({ session: "xyz" });
    expect(input.headers["x-request-id"]).toEqual("req-1");
  });
});
