import { assertEquals } from "@std/assert";
import { assertThrows } from "@std/assert";
import { Matcher } from "./matcher.ts";
import type { RouteDefinition } from "./types.ts";

/** Minimal route definition stub for testing */
function stubRoute(
  overrides: Partial<RouteDefinition> = {},
): RouteDefinition {
  return {
    method: "GET",
    path: "/",
    middlewares: [],
    paramSchemas: new Map(),
    inputKind: "none",
    inputOptions: {},
    interceptors: [],
    handler: () => new Response(),
    kind: "http",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Static routes
// ---------------------------------------------------------------------------

Deno.test("Matcher — static route exact match", () => {
  const m = new Matcher();
  const def = stubRoute({ method: "GET", path: "/users" });
  m.add("GET", "/users", def);
  m.compile();

  const result = m.match("GET", "/users");
  assertEquals(result?.definition, def);
  assertEquals(result?.params, {});
});

Deno.test("Matcher — static route no match", () => {
  const m = new Matcher();
  m.add("GET", "/users", stubRoute({ path: "/users" }));
  m.compile();

  assertEquals(m.match("GET", "/other"), null);
});

// ---------------------------------------------------------------------------
// Dynamic routes
// ---------------------------------------------------------------------------

Deno.test("Matcher — single param", () => {
  const m = new Matcher();
  const def = stubRoute({ method: "GET", path: "/users/:id" });
  m.add("GET", "/users/:id", def);
  m.compile();

  const result = m.match("GET", "/users/42");
  assertEquals(result?.definition, def);
  assertEquals(result?.params, { id: "42" });
});

Deno.test("Matcher — multiple params", () => {
  const m = new Matcher();
  const def = stubRoute({ path: "/users/:id/posts/:pid" });
  m.add("GET", "/users/:id/posts/:pid", def);
  m.compile();

  const result = m.match("GET", "/users/1/posts/2");
  assertEquals(result?.params, { id: "1", pid: "2" });
});

Deno.test("Matcher — wildcard", () => {
  const m = new Matcher();
  const def = stubRoute({ path: "/files/*" });
  m.add("GET", "/files/*", def);
  m.compile();

  const result = m.match("GET", "/files/a/b/c");
  assertEquals(result?.params, { "*": "a/b/c" });
});

Deno.test("Matcher — optional param present", () => {
  const m = new Matcher();
  const def = stubRoute({ path: "/users/:id?" });
  m.add("GET", "/users/:id?", def);
  m.compile();

  const result = m.match("GET", "/users/42");
  assertEquals(result?.params, { id: "42" });
});

Deno.test("Matcher — optional param absent", () => {
  const m = new Matcher();
  const def = stubRoute({ path: "/users/:id?" });
  m.add("GET", "/users/:id?", def);
  m.compile();

  const result = m.match("GET", "/users");
  assertEquals(result?.definition, def);
  assertEquals(result?.params, {});
});

// ---------------------------------------------------------------------------
// ALL method
// ---------------------------------------------------------------------------

Deno.test("Matcher — ALL method matches any HTTP method", () => {
  const m = new Matcher();
  const def = stubRoute({ path: "/health" });
  m.add("ALL", "/health", def);
  m.compile();

  assertEquals(m.match("GET", "/health")?.definition, def);
  assertEquals(m.match("POST", "/health")?.definition, def);
  assertEquals(m.match("DELETE", "/health")?.definition, def);
});

// ---------------------------------------------------------------------------
// Priority / specificity
// ---------------------------------------------------------------------------

Deno.test("Matcher — static route takes priority over dynamic", () => {
  const m = new Matcher();
  const staticDef = stubRoute({ path: "/users/me" });
  const dynamicDef = stubRoute({ path: "/users/:id" });
  m.add("GET", "/users/:id", dynamicDef);
  m.add("GET", "/users/me", staticDef);
  m.compile();

  assertEquals(m.match("GET", "/users/me")?.definition, staticDef);
  assertEquals(m.match("GET", "/users/42")?.definition, dynamicDef);
});

Deno.test("Matcher — more specific dynamic route wins", () => {
  const m = new Matcher();
  const specific = stubRoute({ path: "/a/:x/b/:y" });
  const wildcard = stubRoute({ path: "/a/*" });
  m.add("GET", "/a/*", wildcard);
  m.add("GET", "/a/:x/b/:y", specific);
  m.compile();

  assertEquals(m.match("GET", "/a/1/b/2")?.definition, specific);
});

// ---------------------------------------------------------------------------
// 405 Method Not Allowed
// ---------------------------------------------------------------------------

Deno.test("Matcher — 405 when path matches but method doesn't", () => {
  const m = new Matcher();
  m.add("POST", "/users", stubRoute({ method: "POST", path: "/users" }));
  m.compile();

  const result = m.match("GET", "/users");
  assertEquals(result?.allowedMethods, ["POST"]);
});

Deno.test("Matcher — 405 with multiple allowed methods", () => {
  const m = new Matcher();
  m.add("GET", "/users", stubRoute({ method: "GET", path: "/users" }));
  m.add("POST", "/users", stubRoute({ method: "POST", path: "/users" }));
  m.compile();

  const result = m.match("DELETE", "/users");
  assertEquals(result?.allowedMethods?.sort(), ["GET", "POST"]);
});

// ---------------------------------------------------------------------------
// compile guard
// ---------------------------------------------------------------------------

Deno.test("Matcher — throws when adding after compile", () => {
  const m = new Matcher();
  m.compile();
  assertThrows(() => m.add("GET", "/x", stubRoute()), Error);
});

// ---------------------------------------------------------------------------
// Case sensitivity
// ---------------------------------------------------------------------------

Deno.test("Matcher — case sensitive matching", () => {
  const m = new Matcher();
  m.add("GET", "/Users", stubRoute({ path: "/Users" }));
  m.compile();

  assertEquals(m.match("GET", "/Users")?.definition !== undefined, true);
  assertEquals(m.match("GET", "/users"), null);
});
