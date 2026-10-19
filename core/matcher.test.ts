import { expect, test } from "bun:test";
import { Matcher } from "./matcher.ts";
import type { RouteDefinition } from "./types.ts";

/** Minimal route definition stub for testing */
function stubRoute(overrides: Partial<RouteDefinition> = {}): RouteDefinition {
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

test("Matcher — static route exact match", () => {
  const m = new Matcher();
  const def = stubRoute({ method: "GET", path: "/users" });
  m.add("GET", "/users", def);
  m.compile();

  const result = m.match("GET", "/users");
  expect(result?.definition).toEqual(def);
  expect(result?.params).toEqual({});
});

test("Matcher — static route no match", () => {
  const m = new Matcher();
  m.add("GET", "/users", stubRoute({ path: "/users" }));
  m.compile();

  expect(m.match("GET", "/other")).toEqual(null);
});

// ---------------------------------------------------------------------------
// Dynamic routes
// ---------------------------------------------------------------------------

test("Matcher — single param", () => {
  const m = new Matcher();
  const def = stubRoute({ method: "GET", path: "/users/:id" });
  m.add("GET", "/users/:id", def);
  m.compile();

  const result = m.match("GET", "/users/42");
  expect(result?.definition).toEqual(def);
  expect(result?.params).toEqual({ id: "42" });
});

test("Matcher — multiple params", () => {
  const m = new Matcher();
  const def = stubRoute({ path: "/users/:id/posts/:pid" });
  m.add("GET", "/users/:id/posts/:pid", def);
  m.compile();

  const result = m.match("GET", "/users/1/posts/2");
  expect(result?.params).toEqual({ id: "1", pid: "2" });
});

test("Matcher — segment wildcard", () => {
  const m = new Matcher();
  const def = stubRoute({ path: "/files/*" });
  m.add("GET", "/files/*", def);
  m.compile();

  expect(m.match("GET", "/files/a")?.definition).toEqual(def);
  expect(m.match("GET", "/files/a")?.params).toEqual({});
  expect(m.match("GET", "/files/a/b/c")).toEqual(null);
});

test("Matcher — deep wildcard", () => {
  const m = new Matcher();
  const def = stubRoute({ path: "/files/**" });
  m.add("GET", "/files/**", def);
  m.compile();

  expect(m.match("GET", "/files")?.definition).toEqual(def);
  expect(m.match("GET", "/files/a/b/c")?.definition).toEqual(def);
  expect(m.match("GET", "/files/a/b/c")?.params).toEqual({});
});

test("Matcher — glob segment with alternation", () => {
  const m = new Matcher();
  const def = stubRoute({ path: "/assets/*.{css,js}" });
  m.add("GET", "/assets/*.{css,js}", def);
  m.compile();

  expect(m.match("GET", "/assets/app.css")?.definition).toEqual(def);
  expect(m.match("GET", "/assets/app.js")?.definition).toEqual(def);
  expect(m.match("GET", "/assets/app.png")).toEqual(null);
  expect(m.match("GET", "/assets/nested/app.css")).toEqual(null);
});

test("Matcher — optional param present", () => {
  const m = new Matcher();
  const def = stubRoute({ path: "/users/:id?" });
  m.add("GET", "/users/:id?", def);
  m.compile();

  const result = m.match("GET", "/users/42");
  expect(result?.params).toEqual({ id: "42" });
});

test("Matcher — optional param absent", () => {
  const m = new Matcher();
  const def = stubRoute({ path: "/users/:id?" });
  m.add("GET", "/users/:id?", def);
  m.compile();

  const result = m.match("GET", "/users");
  expect(result?.definition).toEqual(def);
  expect(result?.params).toEqual({});
});

// ---------------------------------------------------------------------------
// ALL method
// ---------------------------------------------------------------------------

test("Matcher — ALL method matches any HTTP method", () => {
  const m = new Matcher();
  const def = stubRoute({ path: "/health" });
  m.add("ALL", "/health", def);
  m.compile();

  expect(m.match("GET", "/health")?.definition).toEqual(def);
  expect(m.match("POST", "/health")?.definition).toEqual(def);
  expect(m.match("DELETE", "/health")?.definition).toEqual(def);
});

// ---------------------------------------------------------------------------
// Priority / specificity
// ---------------------------------------------------------------------------

test("Matcher — static route takes priority over dynamic", () => {
  const m = new Matcher();
  const staticDef = stubRoute({ path: "/users/me" });
  const dynamicDef = stubRoute({ path: "/users/:id" });
  m.add("GET", "/users/:id", dynamicDef);
  m.add("GET", "/users/me", staticDef);
  m.compile();

  expect(m.match("GET", "/users/me")?.definition).toEqual(staticDef);
  expect(m.match("GET", "/users/42")?.definition).toEqual(dynamicDef);
});

test("Matcher — more specific dynamic route wins", () => {
  const m = new Matcher();
  const specific = stubRoute({ path: "/a/:x/b/:y" });
  const wildcard = stubRoute({ path: "/a/**" });
  m.add("GET", "/a/**", wildcard);
  m.add("GET", "/a/:x/b/:y", specific);
  m.compile();

  expect(m.match("GET", "/a/1/b/2")?.definition).toEqual(specific);
});

test("Matcher — param route beats segment glob", () => {
  const m = new Matcher();
  const param = stubRoute({ path: "/assets/:file" });
  const glob = stubRoute({ path: "/assets/*" });
  m.add("GET", "/assets/*", glob);
  m.add("GET", "/assets/:file", param);
  m.compile();

  expect(m.match("GET", "/assets/app.css")?.definition).toEqual(param);
});

test("Matcher — segment glob beats deep wildcard", () => {
  const m = new Matcher();
  const segment = stubRoute({ path: "/assets/*.{css,js}" });
  const deep = stubRoute({ path: "/assets/**" });
  m.add("GET", "/assets/**", deep);
  m.add("GET", "/assets/*.{css,js}", segment);
  m.compile();

  expect(m.match("GET", "/assets/app.css")?.definition).toEqual(segment);
  expect(m.match("GET", "/assets/nested/app.css")?.definition).toEqual(deep);
});

test("Matcher — rest param captures the remainder", () => {
  const m = new Matcher();
  const def = stubRoute({ path: "/static/:path*" });
  m.add("GET", "/static/:path*", def);
  m.compile();

  expect(m.match("GET", "/static/a/b.css")?.params).toEqual({
    path: "a/b.css",
  });
  expect(m.match("GET", "/static")?.params).toEqual({});
});

test("Matcher — every other route beats a rest param", () => {
  const m = new Matcher();
  const rest = stubRoute({ path: "/:path*" });
  const param = stubRoute({ path: "/users/:id" });
  const glob = stubRoute({ path: "/api/**" });
  m.add("GET", "/:path*", rest);
  m.add("GET", "/users/:id", param);
  m.add("GET", "/api/**", glob);
  m.compile();

  expect(m.match("GET", "/users/1")?.definition).toEqual(param);
  expect(m.match("GET", "/api/x/y")?.definition).toEqual(glob);
  expect(m.match("GET", "/dashboard/settings")?.definition).toEqual(rest);
});

// ---------------------------------------------------------------------------
// 405 Method Not Allowed
// ---------------------------------------------------------------------------

test("Matcher — 405 when path matches but method doesn't", () => {
  const m = new Matcher();
  m.add("POST", "/users", stubRoute({ method: "POST", path: "/users" }));
  m.compile();

  const result = m.match("GET", "/users");
  expect(result?.allowedMethods).toEqual(["POST"]);
});

test("Matcher — 405 with multiple allowed methods", () => {
  const m = new Matcher();
  m.add("GET", "/users", stubRoute({ method: "GET", path: "/users" }));
  m.add("POST", "/users", stubRoute({ method: "POST", path: "/users" }));
  m.compile();

  const result = m.match("DELETE", "/users");
  expect(result?.allowedMethods?.sort()).toEqual(["GET", "POST"]);
});

test("Matcher — 405 with glob path", () => {
  const m = new Matcher();
  m.add(
    "POST",
    "/assets/*.{css,js}",
    stubRoute({ method: "POST", path: "/assets/*.{css,js}" }),
  );
  m.compile();

  const result = m.match("GET", "/assets/app.css");
  expect(result?.allowedMethods).toEqual(["POST"]);
});

// ---------------------------------------------------------------------------
// compile guard
// ---------------------------------------------------------------------------

test("Matcher — throws when adding after compile", () => {
  const m = new Matcher();
  m.compile();
  expect(() => m.add("GET", "/x", stubRoute())).toThrow(Error);
});

// ---------------------------------------------------------------------------
// Case sensitivity
// ---------------------------------------------------------------------------

test("Matcher — case sensitive matching", () => {
  const m = new Matcher();
  m.add("GET", "/Users", stubRoute({ path: "/Users" }));
  m.compile();

  expect(m.match("GET", "/Users")?.definition !== undefined).toEqual(true);
  expect(m.match("GET", "/users")).toEqual(null);
});
