import { afterAll, describe, expect, it } from "bun:test";
import path from "node:path";
import { createFixture } from "./_test_utils.ts";
import {
  BAD_ENCODING,
  isSafeSegment,
  isWithin,
  locate,
  parseRequestPath,
} from "./resolve.ts";

describe("parseRequestPath", () => {
  it("maps an absent remainder to the mount root without a slash", () => {
    expect(parseRequestPath(undefined)).toEqual({
      segments: [],
      trailingSlash: false,
    });
  });

  it("maps an empty remainder to the mount root with a slash", () => {
    expect(parseRequestPath("")).toEqual({ segments: [], trailingSlash: true });
  });

  it("splits and decodes nested paths", () => {
    expect(parseRequestPath("a/b%20c/d.txt")).toEqual({
      segments: ["a", "b c", "d.txt"],
      trailingSlash: false,
    });
  });

  it("records a trailing slash", () => {
    expect(parseRequestPath("docs/")).toEqual({
      segments: ["docs"],
      trailingSlash: true,
    });
  });

  it("decodes exactly once (double encoding stays literal)", () => {
    expect(parseRequestPath("%252e%252e")).toEqual({
      segments: ["%2e%2e"],
      trailingSlash: false,
    });
    expect(parseRequestPath("%252e%252e%252fsecret.txt")).toEqual({
      segments: ["%2e%2e%2fsecret.txt"],
      trailingSlash: false,
    });
  });

  it("returns BAD_ENCODING for malformed percent sequences", () => {
    for (const raw of ["%", "%zz", "a/%E0%A4%A", "%ff"]) {
      expect(parseRequestPath(raw)).toBe(BAD_ENCODING);
    }
  });

  // Raw remainders an attacker can get past WHATWG URL normalization, plus
  // ones it would normally collapse (defense in depth).
  const rejected: [string, string][] = [
    ["..", "parent segment"],
    ["a/../b", "parent in the middle"],
    [".", "current segment"],
    ["a/./b", "current in the middle"],
    ["%2e%2e", "encoded parent"],
    ["%2E%2E/secret.txt", "upper-case encoded parent"],
    [".%2e", "half-encoded parent"],
    ["..%2fsecret.txt", "encoded slash after parent"],
    ["..%2F..%2Fetc%2Fpasswd", "encoded traversal chain"],
    ["%2fetc%2fpasswd", "absolute path after decoding"],
    ["..%5csecret.txt", "encoded backslash"],
    ["a%5c..%5c..%5csecret.txt", "backslash traversal"],
    ["..\\secret.txt", "raw backslash"],
    ["a//b", "empty middle segment"],
    ["/etc/passwd", "leading empty segment"],
    ["%00", "NUL byte"],
    ["hello.txt%00.png", "NUL truncation"],
    ["a%0ab", "newline"],
    ["a%7fb", "DEL"],
    ["a%1bb", "escape"],
  ];
  for (const [raw, why] of rejected) {
    it(`rejects ${why}: ${JSON.stringify(raw)}`, () => {
      expect(parseRequestPath(raw, false)).toBeNull();
      expect(parseRequestPath(raw, true)).toBeNull();
    });
  }
});

describe("isSafeSegment", () => {
  it("accepts ordinary names, unicode and spaces inside", () => {
    for (const s of ["a.txt", "with space.txt", "ü.txt", "日本.html", "a:b"]) {
      expect(isSafeSegment(s, false)).toBe(true);
    }
  });

  it("applies Windows rules only when asked", () => {
    const windowsOnly = [
      "file.txt::$DATA", // alternate data stream
      "a:b",
      "trailing.",
      "trailing ",
      "CON",
      "nul.txt",
      "Com1",
      "LPT9.log",
      "a<b",
      'a"b',
      "a|b",
      "a?b",
      "a*b",
    ];
    for (const s of windowsOnly) {
      expect(isSafeSegment(s, true)).toBe(false);
      expect(isSafeSegment(s, false)).toBe(true);
    }
  });

  it("keeps names that merely contain device words on Windows", () => {
    expect(isSafeSegment("console.txt", true)).toBe(true);
    expect(isSafeSegment("com10", true)).toBe(true);
  });
});

describe("isWithin", () => {
  const root = path.join(path.sep, "srv", "public");

  it("accepts the root and paths below it", () => {
    expect(isWithin(root, root)).toBe(true);
    expect(isWithin(root, path.join(root, "a", "b"))).toBe(true);
  });

  it("rejects a sibling sharing the root's name prefix", () => {
    expect(isWithin(root, `${root}-secrets`)).toBe(false);
    expect(isWithin(root, path.join(`${root}-secrets`, "key.txt"))).toBe(false);
  });

  it("rejects parents", () => {
    expect(isWithin(root, path.dirname(root))).toBe(false);
  });
});

describe("locate", () => {
  const fx = createFixture();
  afterAll(() => fx.cleanup());

  it("finds regular files and directories", async () => {
    expect((await locate(fx.root, ["hello.txt"], "within-root"))?.abs).toBe(
      path.join(fx.root, "hello.txt"),
    );
    expect(
      (await locate(fx.root, ["docs"], "within-root"))?.stat.isDirectory(),
    ).toBe(true);
  });

  it("returns null for missing files", async () => {
    expect(await locate(fx.root, ["nope.txt"], "within-root")).toBeNull();
  });

  it("stops lexical escapes even if a caller skips segment validation", async () => {
    for (const policy of ["within-root", "deny", "follow"] as const) {
      expect(await locate(fx.root, ["..", "secret.txt"], policy)).toBeNull();
      expect(
        await locate(fx.root, ["..", "public-secrets", "key.txt"], policy),
      ).toBeNull();
    }
  });

  describe('symlinks: "within-root"', () => {
    it("follows links that stay inside and returns the real path", async () => {
      expect((await locate(fx.root, ["link-in"], "within-root"))?.abs).toBe(
        path.join(fx.root, "hello.txt"),
      );
      expect(
        (await locate(fx.root, ["link-dir-in", "guide.txt"], "within-root"))
          ?.abs,
      ).toBe(path.join(fx.root, "docs", "guide.txt"));
    });

    it("refuses links that leave the root", async () => {
      expect(await locate(fx.root, ["link-out"], "within-root")).toBeNull();
      expect(
        await locate(fx.root, ["link-dir-out", "key.txt"], "within-root"),
      ).toBeNull();
    });

    it("treats dangling links as missing", async () => {
      expect(await locate(fx.root, ["dangling"], "within-root")).toBeNull();
    });
  });

  describe('symlinks: "deny"', () => {
    it("refuses every link, inside or out, at any depth", async () => {
      expect(await locate(fx.root, ["link-in"], "deny")).toBeNull();
      expect(
        await locate(fx.root, ["link-dir-in", "guide.txt"], "deny"),
      ).toBeNull();
      expect(await locate(fx.root, ["link-out"], "deny")).toBeNull();
    });

    it("still serves plain files", async () => {
      expect(
        await locate(fx.root, ["docs", "guide.txt"], "deny"),
      ).not.toBeNull();
    });
  });

  describe('symlinks: "follow"', () => {
    it("follows links anywhere (explicit opt-in)", async () => {
      expect(await locate(fx.root, ["link-out"], "follow")).not.toBeNull();
    });
  });

  describe("canonical policy check", () => {
    it("passes the on-disk segments, not the requested alias", async () => {
      const seen: string[][] = [];
      const allow = (segments: string[]) => {
        seen.push(segments);
        return true;
      };
      await locate(fx.root, ["link-dir-in", "guide.txt"], "within-root", allow);
      expect(seen).toEqual([["docs", "guide.txt"]]);
    });

    it("rejects when the canonical name is refused, in every mode", async () => {
      const noDotfiles = (segments: string[]) =>
        !segments.some((s) => s.startsWith("."));
      for (const policy of ["within-root", "follow"] as const) {
        expect(
          await locate(fx.root, ["env-alias"], policy, noDotfiles),
        ).toBeNull();
      }
      // "deny" refuses the link itself before any canonical check
      expect(
        await locate(fx.root, ["env-alias"], "deny", noDotfiles),
      ).toBeNull();
    });

    it("is skipped for targets outside the root under follow", async () => {
      const allow = () => false;
      expect(
        await locate(fx.root, ["link-out"], "follow", allow),
      ).not.toBeNull();
    });
  });

  it("refuses FIFOs instead of hanging on them", async () => {
    if (!fx.hasFifo) return;
    for (const policy of ["within-root", "deny", "follow"] as const) {
      expect(await locate(fx.root, ["fifo"], policy)).toBeNull();
    }
  });
});
