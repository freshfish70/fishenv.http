import { describe, expect, it } from "bun:test";
import { applyRules, compileGlob, compileRules, matchesGlob } from "./rules.ts";

describe("compileGlob", () => {
  const matches = (pattern: string, rel: string) =>
    matchesGlob(compileGlob(pattern), rel);

  it("uses route glob syntax", () => {
    expect(matches("assets/*.{js,css}", "assets/app.js")).toBe(true);
    expect(matches("assets/*.{js,css}", "assets/app.png")).toBe(false);
    expect(matches("assets/*.{js,css}", "assets/x/app.js")).toBe(false);
    expect(matches("assets/**", "assets/x/y/app.js")).toBe(true);
    expect(matches("**/*.map", "app.js.map")).toBe(true);
    expect(matches("**/*.map", "a/b/app.js.map")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(matches("**/*.key", "Secret.KEY")).toBe(true);
    expect(matches("api/**", "API/users")).toBe(true);
  });

  it("ignores a leading slash in the pattern", () => {
    expect(matches("/downloads/**", "downloads/a.zip")).toBe(true);
  });

  it("treats regex metacharacters literally", () => {
    expect(matches("a.b", "axb")).toBe(false);
    expect(matches("(x)+", "(x)+")).toBe(true);
  });

  it("rejects :param segments and empty patterns", () => {
    expect(() => compileGlob("files/:name")).toThrow(/:param/);
    expect(() => compileGlob("")).toThrow();
  });
});

describe("applyRules", () => {
  it("folds matching rules in order; later wins per field, headers merge", () => {
    const rules = compileRules([
      {
        match: "**",
        cacheControl: "no-cache",
        headers: { "X-A": "1", "X-B": "1" },
      },
      {
        match: "assets/**",
        cacheControl: "immutable",
        headers: { "X-B": "2" },
      },
      { match: "other/**", cacheControl: "never" },
    ]);
    expect(applyRules(rules, "assets/app.js")).toEqual({
      deny: false,
      cacheControl: "immutable",
      headers: { "X-A": "1", "X-B": "2" },
    });
  });

  it("lets a later rule re-allow a denied path", () => {
    const rules = compileRules([
      { match: "**/*.map", deny: true },
      { match: "public/*.map", deny: false },
    ]);
    expect(applyRules(rules, "x.map").deny).toBe(true);
    expect(applyRules(rules, "public/x.map").deny).toBe(false);
  });

  it("rejects unknown rule keys", () => {
    expect(() =>
      compileRules([{ match: "**", denied: true } as never]),
    ).toThrow(/unknown rule option "denied"/);
  });
});
