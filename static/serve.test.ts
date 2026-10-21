/**
 * Behaviour that only exists behind a real `Bun.serve` (Range handling is
 * applied by the server to `Bun.file` bodies), plus `serveFile()`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";
import { type HttpServer, NotFoundError, r, serve } from "../core/index.ts";
import { client, createFixture, MTIME } from "./_test_utils.ts";
import { serveFile, staticFiles } from "./index.ts";

const fx = createFixture();
const digits = fx.write("public/digits.txt", "0123456789");

let server: HttpServer;
let base: string;

beforeAll(() => {
  const app = r()
    .cors({ origin: "https://app.example" })
    .add("/static", staticFiles({ root: fx.root }));
  server = serve(app, { port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop(true);
  fx.cleanup();
});

const get = (urlPath: string, headers: Record<string, string> = {}) =>
  fetch(base + urlPath, { headers });

describe("Range (handled by Bun)", () => {
  it("answers a single range with 206", async () => {
    const res = await get("/static/digits.txt", { range: "bytes=2-5" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await res.text()).toBe("2345");
  });

  it("supports suffix and open-ended ranges", async () => {
    expect(
      await (await get("/static/digits.txt", { range: "bytes=-3" })).text(),
    ).toBe("789");
    expect(
      await (await get("/static/digits.txt", { range: "bytes=7-" })).text(),
    ).toBe("789");
  });

  it("keeps our headers on partial responses", async () => {
    const res = await get("/static/digits.txt", { range: "bytes=0-0" });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("etag")).not.toBeNull();
  });

  it("ignores multi-range and sends the whole file", async () => {
    const res = await get("/static/digits.txt", { range: "bytes=0-1,4-5" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("0123456789");
  });

  it("sends the whole file when If-Range does not match", async () => {
    const res = await get("/static/digits.txt", {
      range: "bytes=0-1",
      "if-range": '"stale"',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("0123456789");
  });

  it("resumes via If-Range: <Last-Modified>; weak ETags never match (RFC 9110)", async () => {
    const full = await get("/static/digits.txt");
    const byDate = await get("/static/digits.txt", {
      range: "bytes=0-1",
      "if-range": full.headers.get("last-modified") as string,
    });
    expect(byDate.status).toBe(206);
    const byEtag = await get("/static/digits.txt", {
      range: "bytes=0-1",
      "if-range": full.headers.get("etag") as string,
    });
    expect(byEtag.status).toBe(200);
  });

  it("still applies ranges behind CORS (response re-wrapped)", async () => {
    const res = await get("/static/digits.txt", {
      range: "bytes=1-2",
      origin: "https://app.example",
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app.example",
    );
    expect(await res.text()).toBe("12");
  });

  it("answers 416 for an unsatisfiable range", async () => {
    const res = await get("/static/digits.txt", { range: "bytes=50-60" });
    expect(res.status).toBe(416);
  });
});

describe("over the network", () => {
  it("serves HEAD with the file's Content-Length and no body", async () => {
    const res = await fetch(`${base}/static/digits.txt`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("10");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("etag")).not.toBeNull();
    expect(await res.text()).toBe("");
  });

  it("advertises Accept-Ranges on full responses", async () => {
    const res = await get("/static/digits.txt");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe("10");
  });

  it("does not duplicate Accept-Ranges on partial responses", async () => {
    const res = await get("/static/digits.txt", { range: "bytes=0-1" });
    expect(res.status).toBe(206);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });

  it("does not leak absolute paths in 404 responses", async () => {
    const res = await get("/static/link-out");
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain(fx.base);
    expect(body).not.toContain(path.sep + "public");
  });
});

describe("serveFile", () => {
  const app = r();
  app.get("/report").handle(({ req }) => serveFile(req, digits));
  app
    .get("/gz")
    .handle(({ req }) =>
      serveFile(req, path.join(fx.root, "app.js"), { precompressed: ["gzip"] }),
    );
  app
    .get("/missing")
    .handle(({ req }) => serveFile(req, path.join(fx.root, "nope.txt")));
  app.get("/dir").handle(({ req }) => serveFile(req, fx.root));
  app.get("/upload").handle(({ req }) =>
    serveFile(req, path.join(fx.root, "upload.html"), {
      untrusted: true,
      cacheControl: "private, max-age=10",
      headers: { "X-Extra": "1" },
    }),
  );
  const call = client(app);

  it("serves the file with the standard headers", async () => {
    const res = await call("/report");
    expect(await res.text()).toBe("0123456789");
    expect(res.headers.get("content-type")).toBe("text/plain;charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("last-modified")).toBe(MTIME.toUTCString());
  });

  it("supports conditional requests", async () => {
    const etag = (await call("/report")).headers.get("etag") as string;
    const res = await call("/report", { headers: { "if-none-match": etag } });
    expect(res.status).toBe(304);
  });

  it("negotiates pre-compressed siblings", async () => {
    const res = await call("/gz", { headers: { "accept-encoding": "gzip" } });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("content-type")).toBe(
      "text/javascript;charset=utf-8",
    );
    expect(await res.text()).toBe("GZ-BYTES");
  });

  it("throws NotFoundError for missing files and directories", async () => {
    expect((await call("/missing")).status).toBe(404);
    expect((await call("/dir")).status).toBe(404);
    await expect(
      serveFile(new Request("http://x/"), path.join(fx.root, "nope")),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("applies options", async () => {
    const res = await call("/upload");
    expect(res.headers.get("content-disposition")).toBe("attachment");
    expect(res.headers.get("cache-control")).toBe("private, max-age=10");
    expect(res.headers.get("x-extra")).toBe("1");
  });

  it("rejects unknown options", async () => {
    await expect(
      serveFile(new Request("http://x/"), digits, {
        cachecontrol: "x",
      } as never),
    ).rejects.toThrow(/unknown serveFile option/);
  });
});
