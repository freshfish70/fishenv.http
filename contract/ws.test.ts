import { describe, expect, expectTypeOf, it } from "bun:test";
import * as v from "valibot";
import { ForbiddenError, UnprocessableEntityError } from "../core/error.ts";
import { c } from "./builder.ts";
import {
  CHANNELS_PROTOCOL,
  type InferChannel,
  type InferSocket,
} from "./ws.ts";

const Message = v.object({ id: v.string(), text: v.string() });
const MessageIn = v.object({ text: v.pipe(v.string(), v.maxLength(10)) });
const Ack = v.object({ id: v.string() });
const NumericId = v.pipe(v.string(), v.transform(Number));

const room = c
  .channel("rooms/:roomId")
  .param("roomId", NumericId)
  .join(
    v.object({ lastSeen: v.optional(v.number()) }),
    v.object({
      history: v.array(Message),
    }),
    [ForbiddenError],
  )
  .clientEvent("message", MessageIn, Ack, [UnprocessableEntityError])
  .clientEvent("typing", v.object({}))
  .serverEvent("message", Message)
  .serverEvent("typing", v.object({ userId: v.string() }))
  .presence(v.object({ status: v.picklist(["online", "away"]) }), {
    clientUpdates: true,
  });

const notifications = c
  .channel("users/:userId/notifications")
  .join()
  .serverEvent("notification", v.object({ title: v.string() }));

describe("c.channel", () => {
  it("captures the full definition", () => {
    const def = room._definition;
    expect(def.name).toEqual("rooms/:roomId");
    expect(def.paramSchemas.get("roomId")).toBe(NumericId);
    expect(def.join.errors).toEqual([ForbiddenError]);
    expect([...def.clientEvents.keys()]).toEqual(["message", "typing"]);
    expect(def.clientEvents.get("message")?.reply).toBe(Ack);
    expect(def.clientEvents.get("message")?.errors).toEqual([
      UnprocessableEntityError,
    ]);
    expect(def.clientEvents.get("typing")?.reply).toBeUndefined();
    expect([...def.serverEvents.keys()]).toEqual(["message", "typing"]);
    expect(def.presence?.clientUpdates).toEqual(true);
  });

  it("builders are immutable", () => {
    const base = c.channel("a/:id");
    const withEvent = base.serverEvent("x", v.string());
    expect(base._definition.serverEvents.size).toEqual(0);
    expect(withEvent._definition.serverEvents.size).toEqual(1);
  });

  it("rejects duplicate event names and leading slashes", () => {
    const base = c.channel("a").clientEvent("x", v.string());
    expect(() => base.clientEvent("x", v.string())).toThrow(/already defined/);
    expect(() =>
      c.channel("a").serverEvent("y", v.string()).serverEvent("y", v.string()),
    ).toThrow(/already defined/);
    expect(() => c.channel("/a")).toThrow(/must not start/);
  });

  it("infers params, join, events and presence types", () => {
    type Room = InferChannel<typeof room>;
    expectTypeOf<Room["name"]>().toEqualTypeOf<"rooms/:roomId">();
    expectTypeOf<Room["params"]["roomId"]>().toEqualTypeOf<number>();
    expectTypeOf<Room["params"]>().branded.toEqualTypeOf<{ roomId: number }>();
    expectTypeOf<Room["join"]["payload"]>().toEqualTypeOf<{
      lastSeen?: number | undefined;
    }>();
    expectTypeOf<Room["join"]["reply"]>().toEqualTypeOf<{
      history: { id: string; text: string }[];
    }>();
    expectTypeOf<Room["clientEvents"]["message"]["payload"]>().toEqualTypeOf<{
      text: string;
    }>();
    expectTypeOf<Room["clientEvents"]["message"]["reply"]>().toEqualTypeOf<{
      id: string;
    }>();
    expectTypeOf<
      Room["clientEvents"]["typing"]["reply"]
    >().toEqualTypeOf<undefined>();
    expectTypeOf<Room["serverEvents"]["typing"]["payload"]>().toEqualTypeOf<{
      userId: string;
    }>();
    expectTypeOf<Room["presenceMeta"]["out"]>().toEqualTypeOf<{
      status: "online" | "away";
    }>();
    expectTypeOf<keyof Room["clientEvents"]>().toEqualTypeOf<
      "message" | "typing"
    >();
  });

  it("distinguishes schema input from output (transforms)", () => {
    const ch = c.channel("x").clientEvent("n", NumericId);
    type X = InferChannel<typeof ch>;
    expectTypeOf<X["clientEvents"]["n"]["payloadIn"]>().toEqualTypeOf<string>();
    expectTypeOf<X["clientEvents"]["n"]["payload"]>().toEqualTypeOf<number>();
  });

  it("a channel without join payload/reply infers undefined", () => {
    type N = InferChannel<typeof notifications>;
    expectTypeOf<N["join"]["payload"]>().toEqualTypeOf<undefined>();
    expectTypeOf<N["params"]>().toEqualTypeOf<{ userId: string }>();
    expectTypeOf<N["presenceMeta"]>().toEqualTypeOf<never>();
  });
});

describe("c.ws", () => {
  it("channels() sets kind, protocol and the channel list", () => {
    const socket = c.ws("/socket").channels(room, notifications);
    const def = socket._definition;
    expect(def.kind).toEqual("channels");
    expect(def.protocols).toEqual([CHANNELS_PROTOCOL]);
    expect(def.channels).toEqual([room, notifications]);

    type S = InferSocket<typeof socket>;
    expectTypeOf<S["channelNames"]>().toEqualTypeOf<
      "rooms/:roomId" | "users/:userId/notifications"
    >();
    expectTypeOf<S["kind"]>().toEqualTypeOf<"channels">();
  });

  it("messages() types a raw socket in both directions", () => {
    const Quote = v.object({ price: v.number() });
    const ticker = c
      .ws("/ticker/:symbol")
      .param("symbol", v.pipe(v.string(), v.toUpperCase()))
      .messages({
        client: v.object({ subscribe: v.boolean() }),
        server: Quote,
      });
    expect(ticker._definition.kind).toEqual("messages");
    expect(ticker._definition.messages?.server).toBe(Quote);

    type T = InferSocket<typeof ticker>;
    expectTypeOf<T["clientMessage"]>().toEqualTypeOf<{ subscribe: boolean }>();
    expectTypeOf<T["serverMessage"]>().toEqualTypeOf<{ price: number }>();
    expectTypeOf<T["params"]>().branded.toEqualTypeOf<{ symbol: string }>();
  });

  it("messages() and channels() are mutually exclusive", () => {
    const Any = v.unknown();
    expect(() =>
      c.ws("/a").channels(room).messages({ client: Any, server: Any }),
    ).toThrow(/mutually exclusive/);
    expect(() =>
      c.ws("/a").messages({ client: Any, server: Any }).channels(room),
    ).toThrow(/mutually exclusive/);
  });

  it("rejects listing the same channel twice", () => {
    expect(() => c.ws("/a").channels(room, room)).toThrow(/listed twice/);
  });

  it("raw sockets default to kind raw with no channels", () => {
    const raw = c.ws("/raw").protocols(["v1"]);
    expect(raw._definition.kind).toEqual("raw");
    expect(raw._definition.protocols).toEqual(["v1"]);
  });
});
