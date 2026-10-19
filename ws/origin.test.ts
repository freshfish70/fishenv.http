import { describe, expect, it } from "bun:test";
import {
  createOriginPolicy,
  type OriginSource,
  originSourcesFromCors,
} from "./origin.ts";

function handshake(origin?: string, host = "api.example.com"): Request {
  const headers: Record<string, string> = { host };
  if (origin !== undefined) headers.origin = origin;
  return new Request(`http://${host}/ws`, { headers });
}

async function allowed(
  sources: OriginSource[],
  origin?: string,
  host?: string,
): Promise<boolean> {
  return await createOriginPolicy(sources).check(handshake(origin, host));
}

describe("no Origin header", () => {
  it("is allowed: non-browser clients carry no ambient credentials", async () => {
    expect(await allowed([], undefined)).toEqual(true);
    expect(await allowed(["https://a.test"], undefined)).toEqual(true);
  });
});

describe("same-origin (default)", () => {
  it("an empty source list means same-origin", async () => {
    expect(await allowed([], "https://api.example.com")).toEqual(true);
    expect(await allowed([], "https://evil.test")).toEqual(false);
  });

  it.each([
    ["https://api.example.com", "api.example.com", true],
    ["http://api.example.com", "api.example.com", true],
    ["https://API.Example.COM", "api.example.com", true],
    ["https://api.example.com:443", "api.example.com", true],
    ["https://api.example.com", "api.example.com:443", true],
    ["http://localhost:3000", "localhost:3000", true],
    ["http://localhost:3001", "localhost:3000", false],
    ["http://localhost", "localhost:3000", false],
    ["https://api.example.com.evil.test", "api.example.com", false],
    ["https://sub.api.example.com", "api.example.com", false],
    ["null", "api.example.com", false],
    ["file://api.example.com", "api.example.com", false],
    ["not a url", "api.example.com", false],
  ])("Origin %s vs Host %s → %p", async (origin, host, expected) => {
    expect(await allowed(["same-origin"], origin, host)).toEqual(expected);
  });

  it("rejects when the Host header is missing", async () => {
    const req = new Request("http://x/ws", {
      headers: { origin: "https://x" },
    });
    req.headers.delete("host");
    expect(await createOriginPolicy([]).check(req)).toEqual(false);
  });
});

describe("exact origins", () => {
  const list = ["https://app.example.com", "http://localhost:5173"];

  it.each([
    ["https://app.example.com", true],
    ["https://APP.example.com", true],
    ["https://app.example.com:443", true],
    ["http://app.example.com", false], // scheme matters
    ["https://app.example.com:8443", false], // port matters
    ["https://app.example.com.evil.test", false],
    ["https://evilapp.example.com", false],
    ["http://localhost:5173", true],
    ["http://localhost:5174", false],
  ])("%s → %p", async (origin, expected) => {
    expect(await allowed(list, origin)).toEqual(expected);
  });

  it("explicit sources replace the same-origin default", async () => {
    expect(
      await allowed(["https://app.example.com"], "https://api.example.com"),
    ).toEqual(false);
    expect(
      await allowed(
        ["https://app.example.com", "same-origin"],
        "https://api.example.com",
      ),
    ).toEqual(true);
  });

  it('"null" can be allowed explicitly (sandboxed iframes)', async () => {
    expect(await allowed(["null"], "null")).toEqual(true);
    expect(await allowed(["https://a.test"], "null")).toEqual(false);
  });
});

describe("wildcard subdomains", () => {
  const list = ["https://*.example.com"];

  it.each([
    ["https://a.example.com", true],
    ["https://a.b.example.com", true],
    ["https://A.EXAMPLE.COM", true],
    ["https://example.com", false], // bare apex not matched
    ["https://evilexample.com", false],
    ["https://a.example.com.evil.test", false],
    ["http://a.example.com", false], // scheme mismatch
    ["https://a.example.com:8443", false], // port mismatch
    ["https://a.example.com:443", true], // default port equivalent
  ])("%s → %p", async (origin, expected) => {
    expect(await allowed(list, origin)).toEqual(expected);
  });

  it("supports explicit ports", async () => {
    const ported = ["http://*.local.test:8080"];
    expect(await allowed(ported, "http://a.local.test:8080")).toEqual(true);
    expect(await allowed(ported, "http://a.local.test")).toEqual(false);
  });
});

describe("RegExp sources", () => {
  it("are anchored automatically", async () => {
    const re = [/https:\/\/app\d+\.example\.com/];
    expect(await allowed(re, "https://app1.example.com")).toEqual(true);
    expect(await allowed(re, "https://app1.example.com.evil.test")).toEqual(
      false,
    );
    expect(await allowed(re, "https://xhttps://app1.example.com")).toEqual(
      false,
    );
  });

  it("match against the normalized origin", async () => {
    expect(
      await allowed(
        [/https:\/\/app\.example\.com/],
        "https://APP.example.com:443",
      ),
    ).toEqual(true);
  });

  it("ignore global/sticky flags (no lastIndex state between calls)", async () => {
    const policy = createOriginPolicy([/https:\/\/a\.test/g]);
    for (let i = 0; i < 3; i++) {
      expect(await policy.check(handshake("https://a.test"))).toEqual(true);
    }
  });
});

describe("predicate sources", () => {
  it("receive the raw origin and the request", async () => {
    const seen: string[] = [];
    const policy = createOriginPolicy([
      (origin, req) => {
        seen.push(`${origin}|${new URL(req.url).pathname}`);
        return origin.endsWith(".tenant.test");
      },
    ]);
    expect(await policy.check(handshake("https://a.tenant.test"))).toEqual(
      true,
    );
    expect(await policy.check(handshake("https://evil.test"))).toEqual(false);
    expect(seen[0]).toEqual("https://a.tenant.test|/ws");
  });

  it("may be async", async () => {
    const policy = createOriginPolicy([
      async (origin) => origin === "https://ok.test",
    ]);
    expect(await policy.check(handshake("https://ok.test"))).toEqual(true);
    expect(await policy.check(handshake("https://no.test"))).toEqual(false);
  });

  it("a synchronous match short-circuits pending async ones", async () => {
    const policy = createOriginPolicy([
      () => new Promise<boolean>(() => {}), // never resolves
      "https://fast.test",
    ]);
    expect(policy.check(handshake("https://fast.test"))).toEqual(true);
  });
});

describe('"any"', () => {
  it("disables the check and is flagged", async () => {
    const policy = createOriginPolicy(["any"]);
    expect(policy.allowsAny).toEqual(true);
    expect(await policy.check(handshake("https://evil.test"))).toEqual(true);
  });
});

describe("invalid sources fail fast", () => {
  it.each([
    "app.example.com",
    "https://app.example.com/path",
    "https://*example.com",
    "https://a.*.example.com",
    "*",
  ])("%s throws", (source) => {
    expect(() => createOriginPolicy([source])).toThrow(/Invalid origin/);
  });
});

describe("originSourcesFromCors", () => {
  it("inherits nothing without cors", () => {
    expect(originSourcesFromCors(null)).toEqual({
      sources: [],
      wildcard: false,
    });
  });

  it('does not inherit "*" and flags it', () => {
    expect(originSourcesFromCors({ origin: "*" })).toEqual({
      sources: [],
      wildcard: true,
    });
  });

  it("inherits single and list origins", () => {
    expect(originSourcesFromCors({ origin: "https://a.test" }).sources).toEqual(
      ["https://a.test"],
    );
    const fromList = originSourcesFromCors({
      origin: ["https://a.test", "*"],
    });
    expect(fromList.sources).toEqual(["https://a.test"]);
    expect(fromList.wildcard).toEqual(true);
  });

  it("wraps a cors resolver function as a predicate", async () => {
    const { sources } = originSourcesFromCors({
      origin: (o) => (o === "https://dyn.test" ? o : null),
    });
    expect(await allowed(sources, "https://dyn.test")).toEqual(true);
    expect(await allowed(sources, "https://other.test")).toEqual(false);
  });
});
