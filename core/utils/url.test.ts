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

Deno.test("extractParamNames — globs are not params", () => {
  assertEquals(extractParamNames("/files/*.{css,js}"), []);
  assertEquals(extractParamNames("/files/**"), []);
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

Deno.test("buildRouteRegex — segment wildcard", () => {
  const { regex, paramNames } = buildRouteRegex("/files/*");
  assertEquals(paramNames, []);
  assertEquals(regex.test("/files/a"), true);
  assertEquals(regex.test("/files/a/b/c"), false);
});

Deno.test("buildRouteRegex — segment wildcard with extension set", () => {
  const { regex, paramNames } = buildRouteRegex("/assets/*.{css,js}");
  assertEquals(paramNames, []);
  assertEquals(regex.test("/assets/app.css"), true);
  assertEquals(regex.test("/assets/app.js"), true);
  assertEquals(regex.test("/assets/app.png"), false);
  assertEquals(regex.test("/assets/nested/app.css"), false);
});

Deno.test("buildRouteRegex — single segment glob and suffix wildcard", () => {
  const { regex, paramNames } = buildRouteRegex("/assets/*/image*");
  assertEquals(paramNames, []);
  assertEquals(regex.test("/assets/icons/image"), true);
  assertEquals(regex.test("/assets/icons/image@2x"), true);
  assertEquals(regex.test("/assets/image"), false);
  assertEquals(regex.test("/assets/icons/deeper/image"), false);
});

Deno.test("buildRouteRegex — deep wildcard", () => {
  const { regex, paramNames } = buildRouteRegex("/assets/**/image*");
  assertEquals(paramNames, []);
  assertEquals(regex.test("/assets/image"), true);
  assertEquals(regex.test("/assets/icons/image"), true);
  assertEquals(regex.test("/assets/icons/deeper/image@2x"), true);
});

Deno.test("buildRouteRegex — trailing deep wildcard", () => {
  const { regex } = buildRouteRegex("/files/**");
  assertEquals(regex.test("/files"), true);
  assertEquals(regex.test("/files/a"), true);
  assertEquals(regex.test("/files/a/b/c"), true);
});

Deno.test("buildRouteRegex — root path", () => {
  const { regex } = buildRouteRegex("/");
  assertEquals(regex.test("/"), true);
  assertEquals(regex.test("/anything"), false);
});
