import { expect, test } from "bun:test";
import { buildRouteRegex, extractParamNames, mergePaths } from "./url.ts";

// ---------------------------------------------------------------------------
// mergePaths
// ---------------------------------------------------------------------------

test("mergePaths — basic join", () => {
  expect(mergePaths("/api", "/users")).toEqual("/api/users");
});

test("mergePaths — strips trailing slash from base", () => {
  expect(mergePaths("/api/", "/users")).toEqual("/api/users");
});

test("mergePaths — strips leading slash from sub", () => {
  expect(mergePaths("/api", "users")).toEqual("/api/users");
});

test("mergePaths — both empty yields root", () => {
  expect(mergePaths("", "")).toEqual("/");
});

test("mergePaths — root base with sub", () => {
  expect(mergePaths("/", "/users")).toEqual("/users");
});

test("mergePaths — deep nesting", () => {
  expect(mergePaths("/a/b", "/c/d")).toEqual("/a/b/c/d");
});

// ---------------------------------------------------------------------------
// extractParamNames
// ---------------------------------------------------------------------------

test("extractParamNames — single param", () => {
  expect(extractParamNames("/users/:id")).toEqual(["id"]);
});

test("extractParamNames — multiple params", () => {
  expect(extractParamNames("/users/:id/posts/:pid")).toEqual(["id", "pid"]);
});

test("extractParamNames — optional param", () => {
  expect(extractParamNames("/users/:id?")).toEqual(["id"]);
});

test("extractParamNames — globs are not params", () => {
  expect(extractParamNames("/files/*.{css,js}")).toEqual([]);
  expect(extractParamNames("/files/**")).toEqual([]);
});

test("extractParamNames — rest param drops the star", () => {
  expect(extractParamNames("/files/:dir/:path*")).toEqual(["dir", "path"]);
});

test("extractParamNames — no params", () => {
  expect(extractParamNames("/users")).toEqual([]);
});

// ---------------------------------------------------------------------------
// buildRouteRegex
// ---------------------------------------------------------------------------

test("buildRouteRegex — static path", () => {
  const { regex, paramNames } = buildRouteRegex("/users");
  expect(paramNames).toEqual([]);
  expect(regex.test("/users")).toEqual(true);
  expect(regex.test("/other")).toEqual(false);
});

test("buildRouteRegex — single param", () => {
  const { regex, paramNames } = buildRouteRegex("/users/:id");
  expect(paramNames).toEqual(["id"]);
  const m = regex.exec("/users/123");
  expect(m?.[1]).toEqual("123");
  expect(regex.test("/users/")).toEqual(false);
});

test("buildRouteRegex — multiple params", () => {
  const { regex, paramNames } = buildRouteRegex("/users/:id/posts/:pid");
  expect(paramNames).toEqual(["id", "pid"]);
  const m = regex.exec("/users/42/posts/99");
  expect(m?.[1]).toEqual("42");
  expect(m?.[2]).toEqual("99");
});

test("buildRouteRegex — optional param matches with value", () => {
  const { regex, paramNames } = buildRouteRegex("/users/:id?");
  expect(paramNames).toEqual(["id"]);
  const m = regex.exec("/users/123");
  expect(m?.[1]).toEqual("123");
});

test("buildRouteRegex — optional param matches without value", () => {
  const { regex } = buildRouteRegex("/users/:id?");
  expect(regex.test("/users")).toEqual(true);
});

test("buildRouteRegex — segment wildcard", () => {
  const { regex, paramNames } = buildRouteRegex("/files/*");
  expect(paramNames).toEqual([]);
  expect(regex.test("/files/a")).toEqual(true);
  expect(regex.test("/files/a/b/c")).toEqual(false);
});

test("buildRouteRegex — segment wildcard with extension set", () => {
  const { regex, paramNames } = buildRouteRegex("/assets/*.{css,js}");
  expect(paramNames).toEqual([]);
  expect(regex.test("/assets/app.css")).toEqual(true);
  expect(regex.test("/assets/app.js")).toEqual(true);
  expect(regex.test("/assets/app.png")).toEqual(false);
  expect(regex.test("/assets/nested/app.css")).toEqual(false);
});

test("buildRouteRegex — single segment glob and suffix wildcard", () => {
  const { regex, paramNames } = buildRouteRegex("/assets/*/image*");
  expect(paramNames).toEqual([]);
  expect(regex.test("/assets/icons/image")).toEqual(true);
  expect(regex.test("/assets/icons/image@2x")).toEqual(true);
  expect(regex.test("/assets/image")).toEqual(false);
  expect(regex.test("/assets/icons/deeper/image")).toEqual(false);
});

test("buildRouteRegex — deep wildcard", () => {
  const { regex, paramNames } = buildRouteRegex("/assets/**/image*");
  expect(paramNames).toEqual([]);
  expect(regex.test("/assets/image")).toEqual(true);
  expect(regex.test("/assets/icons/image")).toEqual(true);
  expect(regex.test("/assets/icons/deeper/image@2x")).toEqual(true);
});

test("buildRouteRegex — trailing deep wildcard", () => {
  const { regex } = buildRouteRegex("/files/**");
  expect(regex.test("/files")).toEqual(true);
  expect(regex.test("/files/a")).toEqual(true);
  expect(regex.test("/files/a/b/c")).toEqual(true);
});

test("buildRouteRegex — root path", () => {
  const { regex } = buildRouteRegex("/");
  expect(regex.test("/")).toEqual(true);
  expect(regex.test("/anything")).toEqual(false);
});

test("buildRouteRegex — rest param captures the raw remainder", () => {
  const { regex, paramNames } = buildRouteRegex("/static/:path*");
  expect(paramNames).toEqual(["path"]);
  expect(regex.exec("/static/a")?.[1]).toEqual("a");
  expect(regex.exec("/static/a/b/c.txt")?.[1]).toEqual("a/b/c.txt");
  expect(regex.exec("/static/a%2Fb")?.[1]).toEqual("a%2Fb");
});

test("buildRouteRegex — rest param keeps a trailing slash", () => {
  const { regex } = buildRouteRegex("/static/:path*");
  expect(regex.exec("/static/dir/")?.[1]).toEqual("dir/");
  expect(regex.exec("/static/")?.[1]).toEqual("");
});

test("buildRouteRegex — rest param is absent at the prefix itself", () => {
  const { regex } = buildRouteRegex("/static/:path*");
  const m = regex.exec("/static");
  expect(m).not.toBeNull();
  expect(m?.[1]).toBeUndefined();
});

test("buildRouteRegex — rest param does not match a sibling prefix", () => {
  const { regex } = buildRouteRegex("/static/:path*");
  expect(regex.test("/staticx/a")).toEqual(false);
});

test("buildRouteRegex — rest param at the root", () => {
  const { regex } = buildRouteRegex("/:path*");
  expect(regex.exec("/")?.[1]).toEqual("");
  expect(regex.exec("/a/b")?.[1]).toEqual("a/b");
});

test("buildRouteRegex — rest param after a named param", () => {
  const { regex, paramNames } = buildRouteRegex("/u/:id/:path*");
  expect(paramNames).toEqual(["id", "path"]);
  const m = regex.exec("/u/42/x/y");
  expect([m?.[1], m?.[2]]).toEqual(["42", "x/y"]);
});

test("buildRouteRegex — rest param must be the last segment", () => {
  expect(() => buildRouteRegex("/:path*/edit")).toThrow(/last segment/);
});
