import { afterAll, describe, expect, it } from "bun:test";
import path from "node:path";
import { createFixture } from "./_test_utils.ts";
import { compileServeFileOptions, compileStaticOptions } from "./options.ts";
import type { StaticOptions } from "./types.ts";

const fx = createFixture();
afterAll(() => fx.cleanup());

const compile = (opts: Partial<StaticOptions>) =>
  compileStaticOptions({ root: fx.root, ...opts } as StaticOptions);

describe("compileStaticOptions", () => {
  it("applies safe defaults", () => {
    const cfg = compile({});
    expect(cfg.root).toBe(fx.root);
    expect(cfg.index).toEqual(["index.html"]);
    expect(cfg.dotfiles).toBe("hide");
    expect(cfg.symlinks).toBe("within-root");
    expect(cfg.cacheControl).toBe("no-cache");
    expect(cfg.precompressed).toEqual([]);
    expect(cfg.etag).toBe(true);
    expect(cfg.cache).toBeUndefined();
  });

  it("resolves a relative root and a symlinked root to the real path", () => {
    const rel = path.relative(process.cwd(), fx.root);
    expect(compileStaticOptions({ root: rel }).root).toBe(fx.root);
    const viaLink = path.join(fx.root, "link-dir-in");
    expect(compileStaticOptions({ root: viaLink }).root).toBe(
      path.join(fx.root, "docs"),
    );
  });

  it("throws on unknown keys (typos must not fall back to defaults)", () => {
    expect(() => compile({ dotFiles: "allow" } as never)).toThrow(
      /unknown staticFiles option "dotFiles"/,
    );
    expect(() => compile({ cache: { ttl: 5 } as never })).toThrow(
      /unknown cache option "ttl"/,
    );
  });

  it("throws on a missing, non-directory or filesystem root", () => {
    expect(() => compileStaticOptions({} as StaticOptions)).toThrow(/root/);
    expect(() => compile({ root: path.join(fx.base, "nope") })).toThrow(
      /does not exist/,
    );
    expect(() => compile({ root: path.join(fx.root, "hello.txt") })).toThrow(
      /not a directory/,
    );
    expect(() => compile({ root: path.parse(fx.root).root })).toThrow(
      /filesystem root/,
    );
  });

  it("validates enums, encodings, index names and extensions", () => {
    expect(() => compile({ dotfiles: "show" as never })).toThrow(/dotfiles/);
    expect(() => compile({ symlinks: "yes" as never })).toThrow(/symlinks/);
    expect(() => compile({ precompressed: ["zstd" as never] })).toThrow(/zstd/);
    expect(() => compile({ index: ["../index.html"] })).toThrow(/index/);
    expect(() => compile({ index: ["a/index.html"] })).toThrow(/index/);
    expect(() => compile({ extensions: ["x/y"] })).toThrow(/extension/);
    expect(() => compile({ cache: { ttlMs: 0 } })).toThrow(/positive/);
  });

  it("normalizes extensions with or without a leading dot", () => {
    expect(compile({ extensions: [".html", "htm"] }).extensions).toEqual([
      "html",
      "htm",
    ]);
  });

  it("fills cache defaults for cache: true", () => {
    expect(compile({ cache: true }).cache).toEqual({
      ttlMs: 5_000,
      maxEntries: 10_000,
    });
  });

  describe("untrusted", () => {
    it("defaults symlinks to deny", () => {
      expect(compile({ untrusted: true }).symlinks).toBe("deny");
    });

    it("keeps an explicit symlink policy", () => {
      expect(
        compile({ untrusted: true, symlinks: "within-root" }).symlinks,
      ).toBe("within-root");
    });

    it("refuses dotfiles: allow", () => {
      expect(() => compile({ untrusted: true, dotfiles: "allow" })).toThrow(
        /untrusted/,
      );
    });
  });

  describe("fallback", () => {
    it("accepts a file inside the root", () => {
      expect(compile({ fallback: "index.html" }).fallback).toEqual([
        "index.html",
      ]);
      expect(compile({ fallback: "/docs/index.html" }).fallback).toEqual([
        "docs",
        "index.html",
      ]);
    });

    it("throws when missing, a directory, escaping or hidden", () => {
      expect(() => compile({ fallback: "missing.html" })).toThrow(
        /not a file inside the root/,
      );
      expect(() => compile({ fallback: "docs" })).toThrow(/not a file/);
      expect(() => compile({ fallback: "../secret.txt" })).toThrow(/invalid/);
      expect(() => compile({ fallback: "link-out" })).toThrow(/not a file/);
      expect(() => compile({ fallback: ".env" })).toThrow(/hidden/);
      expect(() =>
        compile({
          fallback: "index.html",
          rules: [{ match: "*.html", deny: true }],
        }),
      ).toThrow(/hidden/);
    });
  });
});

describe("compileServeFileOptions", () => {
  it("rejects staticFiles-only options", () => {
    expect(() => compileServeFileOptions({ root: "x" } as never)).toThrow(
      /unknown serveFile option "root"/,
    );
  });
});
