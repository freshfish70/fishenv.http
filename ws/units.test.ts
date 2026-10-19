import { describe, expect, it } from "bun:test";
import { ForbiddenError, HttpError } from "../core/index.ts";
import {
  isWebSocketUpgrade,
  negotiateProtocol,
  requestedProtocols,
  UpgradeRequiredError,
} from "./helpers.ts";
import { ConnectionCounter, TokenBucket } from "./limits.ts";
import { WsMessage } from "./message.ts";
import {
  closeFrameFor,
  MAX_CLOSE_REASON_BYTES,
  truncateReason,
  WsCloseError,
  WsProtocolError,
} from "./types.ts";

// ── WsMessage ──────────────────────────────────────────────────────────

describe("WsMessage", () => {
  it("text frames", () => {
    const msg = new WsMessage("héllo");
    expect(msg.isBinary).toEqual(false);
    expect(msg.text()).toEqual("héllo");
    expect(msg.size).toEqual(6); // UTF-8 bytes, not chars
    expect([...msg.bytes()]).toEqual([...new TextEncoder().encode("héllo")]);
  });

  it("binary frames", () => {
    const msg = new WsMessage(Buffer.from([104, 105]));
    expect(msg.isBinary).toEqual(true);
    expect(msg.size).toEqual(2);
    expect(msg.text()).toEqual("hi");
  });

  it("invalid UTF-8 in a binary frame is a protocol error", () => {
    const msg = new WsMessage(new Uint8Array([0xff, 0xfe]));
    expect(() => msg.text()).toThrow(WsProtocolError);
  });

  it("json() parses, and malformed input is a protocol error", () => {
    expect(new WsMessage('{"a":1}').json()).toEqual({ a: 1 });
    expect(() => new WsMessage("{").json()).toThrow(WsProtocolError);
  });
});

// ── TokenBucket ────────────────────────────────────────────────────────

describe("TokenBucket", () => {
  it("allows a burst of capacity, then refills continuously", () => {
    let now = 0;
    const bucket = new TokenBucket(3, 1000, () => now);
    expect([bucket.take(), bucket.take(), bucket.take()]).toEqual([
      true,
      true,
      true,
    ]);
    expect(bucket.take()).toEqual(false);

    now = 333; // ~1 token back
    expect(bucket.take()).toEqual(false);
    now = 334;
    expect(bucket.take()).toEqual(true);
    expect(bucket.take()).toEqual(false);
  });

  it("never exceeds capacity after long idle periods", () => {
    let now = 0;
    const bucket = new TokenBucket(2, 100, () => now);
    now = 1_000_000;
    expect([bucket.take(), bucket.take(), bucket.take()]).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("rejects non-positive configuration", () => {
    expect(() => new TokenBucket(0, 100)).toThrow();
    expect(() => new TokenBucket(1, 0)).toThrow();
    expect(() => new TokenBucket(Number.NaN, 100)).toThrow();
  });
});

// ── ConnectionCounter ──────────────────────────────────────────────────

describe("ConnectionCounter", () => {
  it("tracks totals and per-key counts", () => {
    const counter = new ConnectionCounter();
    const a1 = counter.acquire("a");
    const a2 = counter.acquire("a");
    const anon = counter.acquire(null);
    expect(counter.total).toEqual(3);
    expect(counter.count("a")).toEqual(2);

    a1();
    a1(); // idempotent
    expect(counter.count("a")).toEqual(1);
    a2();
    anon();
    expect(counter.total).toEqual(0);
    expect(counter.count("a")).toEqual(0);
  });
});

// ── close-frame mapping ────────────────────────────────────────────────

describe("closeFrameFor", () => {
  it("maps HttpError to 4000 + status with its public message", () => {
    expect(closeFrameFor(new ForbiddenError("No"))).toEqual({
      code: 4403,
      reason: "No",
    });
  });

  it("uses WsCloseError codes as-is", () => {
    expect(closeFrameFor(new WsCloseError(4100, "x"))).toEqual({
      code: 4100,
      reason: "x",
    });
    expect(closeFrameFor(new WsProtocolError()).code).toEqual(1008);
  });

  it("hides unknown errors unless in development", () => {
    const err = new Error("secret detail");
    expect(closeFrameFor(err)).toEqual({
      code: 1011,
      reason: "Internal Error",
    });
    expect(closeFrameFor(err, true).reason).toEqual("secret detail");
    expect(closeFrameFor("not an error", true).reason).toEqual(
      "Internal Error",
    );
  });

  it("out-of-range HttpError statuses fall back to 1011", () => {
    expect(closeFrameFor(new HttpError(1200, "weird")).code).toEqual(1011);
  });
});

describe("truncateReason", () => {
  it("keeps short reasons untouched", () => {
    expect(truncateReason("bye")).toEqual("bye");
  });

  it("caps at 123 bytes without splitting a code point", () => {
    const long = "€".repeat(100); // 3 bytes each
    const out = truncateReason(long);
    expect(new TextEncoder().encode(out).byteLength).toBeLessThanOrEqual(
      MAX_CLOSE_REASON_BYTES,
    );
    expect(out).toEqual("€".repeat(41));
  });
});

// ── helpers ────────────────────────────────────────────────────────────

describe("isWebSocketUpgrade", () => {
  const valid = {
    upgrade: "websocket",
    connection: "keep-alive, Upgrade",
    "sec-websocket-version": "13",
    "sec-websocket-key": "abc",
  };
  const req = (headers: Record<string, string>, method = "GET") =>
    new Request("http://l/", { method, headers });

  it("accepts a valid handshake (case-insensitive tokens)", () => {
    expect(isWebSocketUpgrade(req(valid))).toEqual(true);
    expect(isWebSocketUpgrade(req({ ...valid, upgrade: "WebSocket" }))).toEqual(
      true,
    );
  });

  it.each([
    ["missing upgrade", { ...valid, upgrade: "" }],
    ["wrong upgrade", { ...valid, upgrade: "h2c" }],
    ["missing connection token", { ...valid, connection: "keep-alive" }],
    ["wrong version", { ...valid, "sec-websocket-version": "8" }],
    ["missing key", { ...valid, "sec-websocket-key": "" }],
  ])("rejects %s", (_label, headers) => {
    expect(isWebSocketUpgrade(req(headers))).toEqual(false);
  });

  it("rejects non-GET", () => {
    expect(isWebSocketUpgrade(req(valid, "POST"))).toEqual(false);
  });
});

describe("subprotocol negotiation", () => {
  const req = (offered?: string) =>
    new Request("http://l/", {
      headers: offered ? { "sec-websocket-protocol": offered } : {},
    });

  it("parses the offered list", () => {
    expect(requestedProtocols(req(" a ,b,, c"))).toEqual(["a", "b", "c"]);
    expect(requestedProtocols(req())).toEqual([]);
  });

  it("uses server preference order", () => {
    expect(negotiateProtocol(req("v1, v2"), ["v2", "v1"])).toEqual("v2");
    expect(negotiateProtocol(req("v3"), ["v2", "v1"])).toBeNull();
  });
});

describe("UpgradeRequiredError", () => {
  it("renders 426 with upgrade headers", () => {
    const res = new UpgradeRequiredError().toResponse();
    expect(res.status).toEqual(426);
    expect(res.headers.get("upgrade")).toEqual("websocket");
    expect(new UpgradeRequiredError().code).toEqual("upgrade_required");
  });
});
