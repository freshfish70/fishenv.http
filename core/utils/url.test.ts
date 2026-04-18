import { assertEquals } from "@std/assert";
import { buildRouteRegex, extractParamNames, mergePaths } from "./url.ts";

// ---------------------------------------------------------------------------
// mergePaths
// ---------------------------------------------------------------------------

Deno.test("mergePaths — basic join", () => {
  assertEquals(mergePaths("/api", "/users"), "/api/users");
});

Deno.test("mergePaths — strips trailing slash from base", () => {
  assertEquals(mergePaths("/api/", "/users"), "/api/users");
});

Deno.test("mergePaths — strips leading slash from sub", () => {
  assertEquals(mergePaths("/api", "users"), "/api/users");
});

Deno.test("mergePaths — both empty yields root", () => {
  assertEquals(mergePaths("", ""), "/");
});

Deno.test("mergePaths — root base with sub", () => {
  assertEquals(mergePaths("/", "/users"), "/users");
});

Deno.test("mergePaths — deep nesting", () => {
  assertEquals(mergePaths("/a/b", "/c/d"), "/a/b/c/d");
});

// ---------------------------------------------------------------------------
// extractParamNames
// ---------------------------------------------------------------------------

Deno.test("extractParamNames — single param", () => {
  assertEquals(extractParamNames("/users/:id"), ["id"]);
});

Deno.test("extractParamNames — multiple params", () => {
  assertEquals(extractParamNames("/users/:id/posts/:pid"), ["id", "pid"]);
});

Deno.test("extractParamNames — optional param", () => {
  assertEquals(extractParamNames("/users/:id?"), ["id"]);
});

Deno.test("extractParamNames — wildcard", () => {
  assertEquals(extractParamNames("/files/*"), ["*"]);
});

Deno.test("extractParamNames — no params", () => {
  assertEquals(extractParamNames("/users"), []);
});

// ---------------------------------------------------------------------------
// buildRouteRegex
// ---------------------------------------------------------------------------

Deno.test("buildRouteRegex — static path", () => {
  const { regex, paramNames } = buildRouteRegex("/users");
  assertEquals(paramNames, []);
  assertEquals(regex.test("/users"), true);
  assertEquals(regex.test("/other"), false);
});

Deno.test("buildRouteRegex — single param", () => {
  const { regex, paramNames } = buildRouteRegex("/users/:id");
  assertEquals(paramNames, ["id"]);
  const m = regex.exec("/users/123");
  assertEquals(m?.[1], "123");
  assertEquals(regex.test("/users/"), false);
});

Deno.test("buildRouteRegex — multiple params", () => {
  const { regex, paramNames } = buildRouteRegex("/users/:id/posts/:pid");
  assertEquals(paramNames, ["id", "pid"]);
  const m = regex.exec("/users/42/posts/99");
  assertEquals(m?.[1], "42");
  assertEquals(m?.[2], "99");
});

Deno.test("buildRouteRegex — optional param matches with value", () => {
  const { regex, paramNames } = buildRouteRegex("/users/:id?");
  assertEquals(paramNames, ["id"]);
  const m = regex.exec("/users/123");
  assertEquals(m?.[1], "123");
});

Deno.test("buildRouteRegex — optional param matches without value", () => {
  const { regex } = buildRouteRegex("/users/:id?");
  assertEquals(regex.test("/users"), true);
});

Deno.test("buildRouteRegex — wildcard", () => {
  const { regex, paramNames } = buildRouteRegex("/files/*");
  assertEquals(paramNames, ["*"]);
  const m = regex.exec("/files/a/b/c");
  assertEquals(m?.[1], "a/b/c");
});

Deno.test("buildRouteRegex — root path", () => {
  const { regex } = buildRouteRegex("/");
  assertEquals(regex.test("/"), true);
  assertEquals(regex.test("/anything"), false);
});
