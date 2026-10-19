import { describe, expect, it } from "bun:test";
import {
  acceptsHtml,
  chooseEncoding,
  isNotModified,
  makeEtag,
  parseQList,
} from "./negotiate.ts";

const req = (headers: Record<string, string>) =>
  new Request("http://localhost/", { headers });

describe("parseQList", () => {
  it("parses values, q-values and whitespace", () => {
    expect(parseQList("br;q=0.8, GZIP , *;q=0")).toEqual([
      { value: "br", q: 0.8 },
      { value: "gzip", q: 1 },
      { value: "*", q: 0 },
    ]);
  });

  it("treats a malformed q as 0 and clamps out-of-range q", () => {
    expect(parseQList("br;q=abc, gzip;q=5")).toEqual([
      { value: "br", q: 0 },
      { value: "gzip", q: 1 },
    ]);
  });
});

describe("chooseEncoding", () => {
  const both = ["br", "gzip"] as const;

  it("returns identity without a header", () => {
    expect(chooseEncoding(null, [...both])).toBeUndefined();
  });

  it("returns identity when nothing is available", () => {
    expect(chooseEncoding("br, gzip", [])).toBeUndefined();
  });

  it("prefers the server order on equal q", () => {
    expect(chooseEncoding("gzip, br", [...both])).toBe("br");
    expect(chooseEncoding("gzip, br", ["gzip", "br"])).toBe("gzip");
  });

  it("prefers the higher client q", () => {
    expect(chooseEncoding("br;q=0.5, gzip", [...both])).toBe("gzip");
  });

  it("never picks a coding refused with q=0", () => {
    expect(chooseEncoding("br;q=0, gzip", [...both])).toBe("gzip");
    expect(chooseEncoding("br;q=0", ["br"])).toBeUndefined();
  });

  it("honours * for unlisted codings, but not over an explicit q=0", () => {
    expect(chooseEncoding("*", [...both])).toBe("br");
    expect(chooseEncoding("br;q=0, *", [...both])).toBe("gzip");
    expect(chooseEncoding("*;q=0", [...both])).toBeUndefined();
  });

  it("accepts x-gzip as gzip", () => {
    expect(chooseEncoding("x-gzip", [...both])).toBe("gzip");
  });

  it("ignores codings it cannot serve", () => {
    expect(chooseEncoding("zstd, deflate", [...both])).toBeUndefined();
  });
});

describe("acceptsHtml", () => {
  it("is true for a missing header, html, text/* and */*", () => {
    expect(acceptsHtml(null)).toBe(true);
    expect(acceptsHtml("text/html,application/xhtml+xml")).toBe(true);
    expect(acceptsHtml("text/*")).toBe(true);
    expect(acceptsHtml("*/*")).toBe(true);
  });

  it("is false for API clients and refused html", () => {
    expect(acceptsHtml("application/json")).toBe(false);
    expect(acceptsHtml("text/html;q=0, application/json")).toBe(false);
  });
});

describe("makeEtag", () => {
  it("is weak, has no inode, and differs per encoding", () => {
    const plain = makeEtag(11, 1_700_000_000_123.7);
    expect(plain).toBe(`W/"b-${(1_700_000_000_123).toString(16)}"`);
    expect(makeEtag(11, 1_700_000_000_123, "br")).not.toBe(plain);
    expect(makeEtag(11, 1_700_000_000_123, "gzip")).not.toBe(
      makeEtag(11, 1_700_000_000_123, "br"),
    );
  });
});

describe("isNotModified", () => {
  const etag = 'W/"b-1"';
  const mtime = Date.parse("2026-01-02T03:04:05.678Z");

  it("matches If-None-Match exactly, weakly, in lists and with *", () => {
    expect(isNotModified(req({ "if-none-match": etag }), etag, mtime)).toBe(
      true,
    );
    expect(isNotModified(req({ "if-none-match": '"b-1"' }), etag, mtime)).toBe(
      true,
    );
    expect(
      isNotModified(req({ "if-none-match": '"x", W/"b-1" ' }), etag, mtime),
    ).toBe(true);
    expect(isNotModified(req({ "if-none-match": "*" }), etag, mtime)).toBe(
      true,
    );
    expect(isNotModified(req({ "if-none-match": '"x"' }), etag, mtime)).toBe(
      false,
    );
  });

  it("lets If-None-Match win over If-Modified-Since", () => {
    const headers = {
      "if-none-match": '"stale"',
      "if-modified-since": new Date(mtime + 60_000).toUTCString(),
    };
    expect(isNotModified(req(headers), etag, mtime)).toBe(false);
  });

  it("compares If-Modified-Since at second precision", () => {
    const same = new Date(mtime).toUTCString(); // drops the .678
    expect(isNotModified(req({ "if-modified-since": same }), etag, mtime)).toBe(
      true,
    );
    const earlier = new Date(mtime - 2_000).toUTCString();
    expect(
      isNotModified(req({ "if-modified-since": earlier }), etag, mtime),
    ).toBe(false);
  });

  it("ignores invalid dates and missing validators", () => {
    expect(
      isNotModified(req({ "if-modified-since": "yesterday" }), etag, mtime),
    ).toBe(false);
    expect(isNotModified(req({ "if-none-match": "*" }), undefined, mtime)).toBe(
      false,
    );
    expect(
      isNotModified(
        req({ "if-modified-since": new Date(mtime).toUTCString() }),
        etag,
        undefined,
      ),
    ).toBe(false);
  });
});
