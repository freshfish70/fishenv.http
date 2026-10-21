import { describe, expect, it } from "bun:test";
import {
  FrameError,
  MAX_CHANNEL_NAME_LENGTH,
  parseClientFrame,
} from "./protocol.ts";

describe("parseClientFrame — valid frames", () => {
  it("join / event / leave / presence_update", () => {
    expect(
      parseClientFrame({ t: "join", ref: 1, ch: "rooms/1", d: { a: 1 } }),
    ).toEqual({ t: "join", ref: 1, ch: "rooms/1", d: { a: 1 } });
    expect(
      parseClientFrame({ t: "event", ch: "r", ev: "msg", d: "x" }),
    ).toEqual({
      t: "event",
      ref: undefined,
      ch: "r",
      ev: "msg",
      d: "x",
    });
    expect(parseClientFrame({ t: "leave", ref: 0, ch: "r" })).toEqual({
      t: "leave",
      ref: 0,
      ch: "r",
    });
    expect(
      parseClientFrame({ t: "presence_update", ch: "r", d: {} }).t,
    ).toEqual("presence_update");
  });

  it("drops unknown keys", () => {
    const frame = parseClientFrame({
      t: "leave",
      ch: "r",
      extra: 1,
      admin: true,
    });
    expect(Object.keys(frame).sort()).toEqual(["ch", "ref", "t"]);
  });
});

describe("parseClientFrame — rejections", () => {
  it.each([
    ["null", null],
    ["array", [1, 2]],
    ["string", "join"],
    ["number", 42],
  ])("non-object frame: %s", (_l, value) => {
    expect(() => parseClientFrame(value)).toThrow(FrameError);
  });

  it.each([
    ["unknown type", { t: "admin", ch: "r" }],
    ["missing type", { ch: "r" }],
    ["missing channel", { t: "join" }],
    ["empty channel", { t: "join", ch: "" }],
    ["numeric channel", { t: "join", ch: 1 }],
    [
      "overlong channel",
      { t: "join", ch: "a".repeat(MAX_CHANNEL_NAME_LENGTH + 1) },
    ],
    ["NUL in channel", { t: "join", ch: "a\u0000b" }],
    ["newline in channel", { t: "join", ch: "a\nb" }],
    ["event without ev", { t: "event", ch: "r" }],
    ["event with object ev", { t: "event", ch: "r", ev: {} }],
  ])("%s", (_l, value) => {
    expect(() => parseClientFrame(value)).toThrow(FrameError);
  });

  it.each([-1, 1.5, "1", 2 ** 31, Number.NaN, null])(
    "invalid ref %p",
    (ref) => {
      expect(() => parseClientFrame({ t: "join", ch: "r", ref })).toThrow(
        /Invalid ref/,
      );
    },
  );

  it("recovers ref (and channel) for the error reply when possible", () => {
    try {
      parseClientFrame({ t: "event", ref: 7, ch: "r" });
      throw new Error("unreachable");
    } catch (err) {
      expect(err).toBeInstanceOf(FrameError);
      expect((err as FrameError).ref).toEqual(7);
      expect((err as FrameError).ch).toEqual("r");
    }
  });

  it("__proto__ in a frame is inert", () => {
    const hostile = JSON.parse(
      '{"t":"join","ch":"r","d":{"__proto__":{"polluted":true}},"__proto__":{"polluted":true}}',
    );
    parseClientFrame(hostile);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
