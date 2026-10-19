import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { rmSync, unlinkSync } from "node:fs";
import path from "node:path";
import { r } from "../core/index.ts";
import { client, createFixture, MTIME, mount, SECRET } from "./_test_utils.ts";
import { fsOps } from "./resolve.ts";
import { LookupCache, spa, staticFiles, withStatic } from "./router.ts";

const fx = createFixture();
afterAll(() => fx.cleanup());

const assets = mount("/static", staticFiles({ root: fx.root }));

describe("serving files", () => {
  it("serves a file with type, nosniff, cache and validators", async () => {
    const res = await assets("/static/hello.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello world");
    expect(res.headers.get("content-type")).toBe("text/plain;charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("etag")).toMatch(/^W\/"b-[0-9a-f]+"$/);
    expect(res.headers.get("last-modified")).toBe(MTIME.toUTCString());
    expect(res.headers.get("vary")).toBeNull();
  });

  it("decodes percent-encoded names", async () => {
    const res = await assets("/static/with%20space.txt");
    expect(await res.text()).toBe("spaced");
  });

  it("serves a literal %2e%2e file only via double encoding", async () => {
    const res = await assets("/static/%252e%252e");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("literal percent name");
  });

  it("serves nested files", async () => {
    expect(await (await assets("/static/docs/guide.txt")).text()).toBe("guide");
  });

  it("returns 404 for missing files", async () => {
    expect((await assets("/static/nope.txt")).status).toBe(404);
  });

  it("answers HEAD with headers and no body", async () => {
    const res = await assets("/static/hello.txt", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).not.toBeNull();
    expect(await res.text()).toBe("");
  });

  it("answers 405 for non-GET methods", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await assets("/static/hello.txt", { method });
      expect(res.status).toBe(405);
    }
  });

  it("lets specific app routes win over the static catch-all", async () => {
    const app = r().add("/", staticFiles({ root: fx.root }));
    app.get("/hello.txt").handle(() => new Response("from api"));
    expect(await (await client(app)("/hello.txt")).text()).toBe("from api");
  });
});

describe("attack corpus", () => {
  // Every one of these must answer 400/404 and never leak SECRET.
  const attacks = [
    "/static/../secret.txt",
    "/static/..%2fsecret.txt",
    "/static/..%2Fsecret.txt",
    "/static/%2e%2e/secret.txt",
    "/static/%2e%2e%2fsecret.txt",
    "/static/.%2e/secret.txt",
    "/static/%2e%2e%2f%2e%2e%2fsecret.txt",
    "/static/..%5csecret.txt",
    "/static/..\\secret.txt",
    "/static/%5c..%5csecret.txt",
    "/static/%252e%252e%252fsecret.txt",
    "/static/%2fetc%2fpasswd",
    "/static/%2F..%2Fsecret.txt",
    "/static//etc/passwd",
    "/static/..%2fpublic-secrets%2fkey.txt",
    "/static/%2e%2e/public-secrets/key.txt",
    "/static/link-out",
    "/static/link-dir-out/key.txt",
    "/static/dangling",
    "/static/hello.txt%00.png",
    "/static/%00",
    "/static/a%0ab",
    "/static/.env",
    "/static/.ENV",
    "/static/.git/config",
    "/static/nested/.hidden/x.txt",
    "/static/.git%2fconfig",
    "/static/%2e%65nv",
    "/static/%",
    "/static/%zz",
  ];

  for (const url of attacks) {
    it(`blocks ${url}`, async () => {
      const res = await assets(url);
      expect([400, 404]).toContain(res.status);
      expect(await res.text()).not.toContain(SECRET);
    });
  }

  it("answers 400 only for undecodable percent sequences", async () => {
    expect((await assets("/static/%")).status).toBe(400);
    expect((await assets("/static/a/%E0%A4%A")).status).toBe(400);
    expect((await assets("/static/..%2fsecret.txt")).status).toBe(404);
  });

  it("gives hidden and missing files the identical response", async () => {
    const hidden = await assets("/static/.env");
    const missing = await assets("/static/.nope");
    expect(hidden.status).toBe(missing.status);
    expect(await hidden.text()).toBe(await missing.text());
    expect([...hidden.headers]).toEqual([...missing.headers]);
  });

  it("does not hang on a FIFO", async () => {
    if (!fx.hasFifo) return;
    expect((await assets("/static/fifo")).status).toBe(404);
  });

  it("routes failures through the app's onError chain", async () => {
    const app = r()
      .add("/static", staticFiles({ root: fx.root }))
      .onError(() => new Response("custom", { status: 418 }));
    expect((await client(app)("/static/.env")).status).toBe(418);
  });
});

describe("dotfiles and symlink options", () => {
  it("serves allowDotfiles exceptions but not dotfiles below them", async () => {
    const get = mount(
      "/s",
      staticFiles({ root: fx.root, allowDotfiles: [".well-known"] }),
    );
    expect(await (await get("/s/.well-known/security.txt")).text()).toBe(
      "contact",
    );
    expect((await get("/s/.env")).status).toBe(404);
  });

  it('serves dotfiles with dotfiles: "allow"', async () => {
    const get = mount("/s", staticFiles({ root: fx.root, dotfiles: "allow" }));
    expect((await get("/s/.git/config")).status).toBe(200);
  });

  it("follows in-root symlinks by default", async () => {
    expect(await (await assets("/static/link-in")).text()).toBe("hello world");
    expect(await (await assets("/static/link-dir-in/guide.txt")).text()).toBe(
      "guide",
    );
  });

  it('refuses all symlinks with symlinks: "deny"', async () => {
    const get = mount("/s", staticFiles({ root: fx.root, symlinks: "deny" }));
    expect((await get("/s/link-in")).status).toBe(404);
    expect((await get("/s/link-dir-in/guide.txt")).status).toBe(404);
    expect((await get("/s/hello.txt")).status).toBe(200);
  });
});

describe("directories", () => {
  it("serves the index for a trailing slash", async () => {
    expect(await (await assets("/static/docs/")).text()).toBe("<h1>docs</h1>");
    expect(await (await assets("/static/")).text()).toBe("<h1>shell</h1>");
  });

  it("redirects to the slash form with a relative Location", async () => {
    const res = await assets("/static/docs?x=1");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("./docs/?x=1");
    const rootRes = await assets("/static");
    expect(rootRes.headers.get("location")).toBe("./static/");
  });

  it("never produces a protocol-relative or absolute Location", async () => {
    const atRoot = mount("/", staticFiles({ root: fx.root }));
    for (const url of ["//evil.com", "//evil.com/", "/docs", "/%2fevil.com"]) {
      const res = await atRoot(url);
      const location = res.headers.get("location");
      if (location !== null) expect(location.startsWith("./")).toBe(true);
    }
    expect((await atRoot("//evil.com")).status).toBe(404);
  });

  it("returns 404 for a directory without an index", async () => {
    expect((await assets("/static/noindex/")).status).toBe(404);
    expect((await assets("/static/empty/")).status).toBe(404);
  });

  it("returns 404 for directories when index is disabled", async () => {
    const get = mount("/s", staticFiles({ root: fx.root, index: [] }));
    expect((await get("/s/docs")).status).toBe(404);
    expect((await get("/s/docs/")).status).toBe(404);
  });

  it("returns 404 for a file requested with a trailing slash", async () => {
    expect((await assets("/static/hello.txt/")).status).toBe(404);
  });

  it("applies deny rules to the index file it would serve", async () => {
    const get = mount(
      "/s",
      staticFiles({
        root: fx.root,
        rules: [{ match: "docs/index.html", deny: true }],
      }),
    );
    expect((await get("/s/docs/")).status).toBe(404);
  });
});

describe("extensions", () => {
  const get = mount("/s", staticFiles({ root: fx.root, extensions: ["html"] }));

  it("resolves extension-less paths", async () => {
    expect(await (await get("/s/about")).text()).toBe("<h1>about</h1>");
  });

  it("prefers the exact file and ignores trailing slashes", async () => {
    expect((await get("/s/about/")).status).toBe(404);
    expect((await get("/s/about.html")).status).toBe(200);
  });

  it("checks the derived name against deny rules", async () => {
    const denied = mount(
      "/s",
      staticFiles({
        root: fx.root,
        extensions: ["html"],
        rules: [{ match: "about.html", deny: true }],
      }),
    );
    expect((await denied("/s/about")).status).toBe(404);
  });
});

describe("rules and exclude", () => {
  const get = mount(
    "/s",
    staticFiles({
      root: fx.root,
      headers: { "X-Base": "1" },
      rules: [
        { match: "**/*.{js,css}", cacheControl: "public, max-age=60" },
        {
          match: "app.js",
          cacheControl: "public, max-age=31536000, immutable",
          headers: { "X-Rule": "app" },
        },
        { match: "**/*.map", deny: true },
        { match: "**/*.key", deny: true },
      ],
      exclude: ["docs/**"],
    }),
  );

  it("applies matching rules with later rules winning", async () => {
    const app = await get("/s/app.js");
    expect(app.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(app.headers.get("x-rule")).toBe("app");
    expect(app.headers.get("x-base")).toBe("1");
    const css = await get("/s/style.css");
    expect(css.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("denies case-insensitively", async () => {
    expect((await get("/s/app.js.map")).status).toBe(404);
    expect((await get("/s/Secret.KEY")).status).toBe(404);
    expect((await get("/s/secret.key")).status).toBe(404);
  });

  it("never serves excluded paths", async () => {
    expect((await get("/s/docs/guide.txt")).status).toBe(404);
    expect((await get("/s/docs/")).status).toBe(404);
  });

  it("lets setHeaders override everything last", async () => {
    const seen: unknown[] = [];
    const custom = mount(
      "/s",
      staticFiles({
        root: fx.root,
        rules: [{ match: "**", cacheControl: "rule" }],
        setHeaders: (info, headers) => {
          seen.push(info);
          headers.set("Cache-Control", "from-hook");
        },
      }),
    );
    const res = await custom("/s/docs/guide.txt");
    expect(res.headers.get("cache-control")).toBe("from-hook");
    expect(seen).toEqual([
      { path: "docs/guide.txt", size: 5, mtime: MTIME, encoding: undefined },
    ]);
  });
});

describe("pre-compressed variants", () => {
  const get = mount(
    "/s",
    staticFiles({ root: fx.root, precompressed: ["br", "gzip"] }),
  );

  it("serves br when accepted, with the original content type", async () => {
    const res = await get("/s/app.js", {
      headers: { "accept-encoding": "gzip, br" },
    });
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(res.headers.get("content-type")).toBe(
      "text/javascript;charset=utf-8",
    );
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    expect(await res.text()).toBe("BR-BYTES");
  });

  it("respects q=0 and falls back to gzip", async () => {
    const res = await get("/s/app.js", {
      headers: { "accept-encoding": "br;q=0, gzip" },
    });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(await res.text()).toBe("GZ-BYTES");
  });

  it("serves identity with Vary when nothing matches", async () => {
    const res = await get("/s/app.js");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    expect(await res.text()).toBe("console.log('identity')");
  });

  it("serves identity for files without variants", async () => {
    const res = await get("/s/style.css", {
      headers: { "accept-encoding": "br" },
    });
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
  });

  it("uses a different ETag per encoding", async () => {
    const etags = await Promise.all(
      ["br", "gzip", "identity"].map(async (enc) =>
        (
          await get("/s/app.js", { headers: { "accept-encoding": enc } })
        ).headers.get("etag"),
      ),
    );
    expect(new Set(etags).size).toBe(3);
  });

  it("falls back to the next encoding when a variant vanishes", async () => {
    const root = path.join(fx.base, "vanish");
    fx.write("vanish/a.js", "plain");
    const br = fx.write("vanish/a.js.br", "BR");
    fx.write("vanish/a.js.gz", "GZ");
    const v = mount(
      "/v",
      staticFiles({ root, precompressed: ["br", "gzip"], cache: true }),
    );
    const headers = { "accept-encoding": "br, gzip" };
    expect(await (await v("/v/a.js", { headers })).text()).toBe("BR");
    unlinkSync(br);
    expect(await (await v("/v/a.js", { headers })).text()).toBe("GZ");
  });
});

describe("conditional requests", () => {
  it("answers 304 for a matching If-None-Match, keeping validators", async () => {
    const first = await assets("/static/hello.txt");
    const etag = first.headers.get("etag") as string;
    const res = await assets("/static/hello.txt", {
      headers: { "if-none-match": `"other", ${etag}` },
    });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(res.headers.get("etag")).toBe(etag);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("content-type")).toBeNull();
  });

  it("answers 304 for If-None-Match: *", async () => {
    const res = await assets("/static/hello.txt", {
      headers: { "if-none-match": "*" },
    });
    expect(res.status).toBe(304);
  });

  it("answers 304 for If-Modified-Since at or after mtime", async () => {
    const res = await assets("/static/hello.txt", {
      headers: { "if-modified-since": MTIME.toUTCString() },
    });
    expect(res.status).toBe(304);
  });

  it("lets If-None-Match win over If-Modified-Since", async () => {
    const res = await assets("/static/hello.txt", {
      headers: {
        "if-none-match": '"stale"',
        "if-modified-since": MTIME.toUTCString(),
      },
    });
    expect(res.status).toBe(200);
  });

  it("omits validators when disabled", async () => {
    const get = mount(
      "/s",
      staticFiles({ root: fx.root, etag: false, lastModified: false }),
    );
    const res = await get("/s/hello.txt", {
      headers: {
        "if-none-match": "*",
        "if-modified-since": MTIME.toUTCString(),
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeNull();
    expect(res.headers.get("last-modified")).toBeNull();
  });
});

describe("untrusted content", () => {
  const get = mount("/u", staticFiles({ root: fx.root, untrusted: true }));
  const csp = "sandbox; default-src 'none'";

  it("sandboxes and forces download of active content", async () => {
    for (const file of ["upload.html", "upload.svg", "app.js"]) {
      const res = await get(`/u/${file}`);
      expect(res.headers.get("content-security-policy")).toBe(csp);
      expect(res.headers.get("content-disposition")).toBe("attachment");
    }
  });

  it("shows passive types inline, still sandboxed", async () => {
    for (const file of ["photo.png", "notes.txt"]) {
      const res = await get(`/u/${file}`);
      expect(res.headers.get("content-security-policy")).toBe(csp);
      expect(res.headers.get("content-disposition")).toBeNull();
    }
  });

  it("cannot be weakened by rules", async () => {
    const weak = mount(
      "/u",
      staticFiles({
        root: fx.root,
        untrusted: true,
        rules: [
          { match: "**", headers: { "Content-Security-Policy": "none" } },
        ],
      }),
    );
    const res = await weak("/u/upload.html");
    expect(res.headers.get("content-security-policy")).toBe(csp);
  });

  it("refuses symlinks by default", async () => {
    expect((await get("/u/link-in")).status).toBe(404);
  });
});

describe("SPA fallback", () => {
  const html = { accept: "text/html,application/xhtml+xml" };
  const app = r();
  app.get("/api/users").handle(() => Response.json([]));
  app.add(
    spa({
      root: fx.root,
      exclude: ["api/**"],
      rules: [{ match: "**", cacheControl: "public, max-age=600" }],
    }),
  );
  const get = client(app);

  it("serves real files normally", async () => {
    const res = await get("/hello.txt", { headers: html });
    expect(await res.text()).toBe("hello world");
    expect(res.headers.get("cache-control")).toBe("public, max-age=600");
  });

  it("serves the shell for unknown client routes, always no-cache", async () => {
    for (const url of ["/dashboard", "/dashboard/settings", "/users/42/"]) {
      const res = await get(url, { headers: html });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("<h1>shell</h1>");
      expect(res.headers.get("content-type")).toBe("text/html;charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-cache");
    }
  });

  it("supports 304 revalidation of the shell", async () => {
    const first = await get("/dashboard", { headers: html });
    const etag = first.headers.get("etag") as string;
    const res = await get("/dashboard", {
      headers: { ...html, "if-none-match": etag },
    });
    expect(res.status).toBe(304);
  });

  it("serves the shell without an Accept header", async () => {
    expect((await get("/dashboard")).status).toBe(200);
  });

  it("returns 404 for missing assets (paths with an extension)", async () => {
    expect((await get("/app.3f9a.js", { headers: html })).status).toBe(404);
    expect((await get("/missing.png", { headers: html })).status).toBe(404);
  });

  it("returns 404 for API clients", async () => {
    const res = await get("/dashboard", {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(404);
  });

  it("never serves the shell for hidden, denied or invalid paths", async () => {
    for (const url of ["/.env", "/.git/config", "/..%2fsecret", "/a%00b"]) {
      const res = await get(url, { headers: html });
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("shell");
    }
  });

  it("keeps excluded API paths on a real 404", async () => {
    expect((await get("/api/users")).status).toBe(200);
    const res = await get("/api/unknown", { headers: html });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("shell");
  });

  it("serves the root index", async () => {
    expect(await (await get("/", { headers: html })).text()).toBe(
      "<h1>shell</h1>",
    );
  });

  it("returns 404 if the shell disappears at runtime", async () => {
    const root = path.join(fx.base, "spa-gone");
    const shell = fx.write("spa-gone/index.html", "shell");
    const gone = mount("/", spa({ root }));
    unlinkSync(shell);
    expect((await gone("/dashboard", { headers: html })).status).toBe(404);
  });

  it("throws at creation when the fallback file is missing", () => {
    expect(() => spa({ root: path.join(fx.root, "noindex") })).toThrow(
      /fallback/,
    );
  });
});

describe("lookup cache", () => {
  it("skips realpath on a hit but still checks the file", async () => {
    const get = mount("/s", staticFiles({ root: fx.root, cache: true }));
    await get("/s/hello.txt");
    const realpath = spyOn(fsOps, "realpath");
    try {
      const res = await get("/s/hello.txt");
      expect(await res.text()).toBe("hello world");
      expect(realpath).not.toHaveBeenCalled();
    } finally {
      realpath.mockRestore();
    }
  });

  it("shares one entry across encodings of the same path", async () => {
    const get = mount("/s", staticFiles({ root: fx.root, cache: true }));
    await get("/s/with%20space.txt");
    const realpath = spyOn(fsOps, "realpath");
    try {
      await get("/s/with%20spac%65.txt");
      expect(realpath).not.toHaveBeenCalled();
    } finally {
      realpath.mockRestore();
    }
  });

  it("returns 404 (not a crash) for a file deleted after caching", async () => {
    const root = path.join(fx.base, "cache-delete");
    const file = fx.write("cache-delete/a.txt", "a");
    const get = mount("/s", staticFiles({ root, cache: true }));
    expect((await get("/s/a.txt")).status).toBe(200);
    unlinkSync(file);
    expect((await get("/s/a.txt")).status).toBe(404);
  });

  it("re-resolves when a cached file is replaced by a directory", async () => {
    const root = path.join(fx.base, "cache-swap");
    const file = fx.write("cache-swap/a", "file");
    const get = mount("/s", staticFiles({ root, cache: true }));
    expect(await (await get("/s/a")).text()).toBe("file");
    unlinkSync(file);
    fx.write("cache-swap/a/index.html", "dir");
    expect((await get("/s/a")).status).toBe(301);
  });

  it("serves fresh size and ETag when a cached file changes", async () => {
    const root = path.join(fx.base, "cache-change");
    fx.write("cache-change/a.txt", "one");
    const get = mount("/s", staticFiles({ root, cache: true }));
    const before = (await get("/s/a.txt")).headers.get("etag");
    fx.write("cache-change/a.txt", "changed");
    const res = await get("/s/a.txt");
    expect(await res.text()).toBe("changed");
    expect(res.headers.get("etag")).not.toBe(before);
  });

  it("expires cached misses quickly", async () => {
    const root = path.join(fx.base, "cache-miss");
    fx.write("cache-miss/keep.txt", "k");
    const get = mount(
      "/s",
      staticFiles({ root, cache: { ttlMs: 60_000, maxEntries: 10 } }),
    );
    expect((await get("/s/new.txt")).status).toBe(404);
    fx.write("cache-miss/new.txt", "new");
    expect((await get("/s/new.txt")).status).toBe(404); // cached miss
    await Bun.sleep(1_050);
    expect((await get("/s/new.txt")).status).toBe(200);
  });

  it("clears entries with invalidate()", async () => {
    const root = path.join(fx.base, "cache-invalidate");
    fx.write("cache-invalidate/keep.txt", "k");
    const files = staticFiles({ root, cache: { ttlMs: 60_000 } });
    const get = mount("/s", files);
    expect((await get("/s/new.txt")).status).toBe(404);
    fx.write("cache-invalidate/new.txt", "new");
    files.invalidate("/new.txt");
    expect((await get("/s/new.txt")).status).toBe(200);
    rmSync(path.join(root, "new.txt"));
    fx.write("cache-invalidate/other.txt", "o");
    expect((await get("/s/other.txt")).status).toBe(200);
    files.invalidate();
    expect((await get("/s/new.txt")).status).toBe(404);
  });

  it("does not cache rejected requests", async () => {
    const get = mount("/s", staticFiles({ root: fx.root, cache: true }));
    const realpath = spyOn(fsOps, "realpath");
    try {
      await get("/s/.env");
      await get("/s/..%2fsecret.txt");
      expect(realpath).not.toHaveBeenCalled();
    } finally {
      realpath.mockRestore();
    }
  });
});

describe("LookupCache", () => {
  it("stays within maxEntries under a flood and evicts least recently used", () => {
    const cache = new LookupCache({ ttlMs: 60_000, maxEntries: 10 });
    cache.set("keep", { kind: "missing" });
    for (let i = 0; i < 1_000; i++) {
      cache.set(`junk-${i}`, { kind: "missing" });
      if (i % 5 === 0) cache.get("keep"); // keep it hot
      expect(cache.size).toBeLessThanOrEqual(10);
    }
    expect(cache.get("keep")).toEqual({ kind: "missing" });
    expect(cache.get("junk-0")).toBeUndefined();
  });

  it("drops expired entries on read", async () => {
    const cache = new LookupCache({ ttlMs: 10, maxEntries: 10 });
    cache.set("a", { kind: "redirect" });
    await Bun.sleep(20);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});

describe("withStatic", () => {
  it("mounts staticFiles under a prefix and returns the router", async () => {
    const app = r();
    expect(withStatic(app, "/assets", { root: fx.root })).toBe(app);
    expect(await (await client(app)("/assets/hello.txt")).text()).toBe(
      "hello world",
    );
  });

  it("runs the parent's middleware (e.g. auth) before serving", async () => {
    const authed = r().use(({ req }) => {
      if (req.headers.get("authorization") !== "yes") {
        throw new (class extends Error {})("denied");
      }
      return { user: "u" };
    });
    authed.onError(() => new Response("unauthorized", { status: 401 }));
    withStatic(authed, "/private", { root: fx.root });
    const get = client(authed);
    expect((await get("/private/hello.txt")).status).toBe(401);
    const ok = await get("/private/hello.txt", {
      headers: { authorization: "yes" },
    });
    expect(ok.status).toBe(200);
  });
});
