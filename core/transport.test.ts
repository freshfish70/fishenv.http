import { describe, expect, it } from "bun:test";
import {
  createMemoryTransport,
  createTransportBridge,
  type Transport,
  type TransportEnvelope,
} from "./transport.ts";

interface Msg extends TransportEnvelope {
  n: number;
}

const silent = { error() {} };

describe("createTransportBridge", () => {
  it("stamps origin and delivers to other nodes only", () => {
    const transport = createMemoryTransport<Msg>();
    const seenA: Msg[] = [];
    const seenB: Msg[] = [];
    const a = createTransportBridge(transport, (m) => seenA.push(m));
    const b = createTransportBridge(transport, (m) => seenB.push(m));

    a.publish({ n: 1 });

    expect(seenA).toEqual([]); // own echo suppressed
    expect(seenB).toEqual([{ n: 1, origin: a.nodeId }]);
    expect(a.nodeId).not.toEqual(b.nodeId);
  });

  it("is a no-op without a transport", () => {
    const bridge = createTransportBridge<Msg>(undefined, () => {
      throw new Error("never");
    });
    expect(() => bridge.publish({ n: 1 })).not.toThrow();
    expect(() => bridge.close()).not.toThrow();
  });

  it("close() detaches the subscription", () => {
    const transport = createMemoryTransport<Msg>();
    const seen: Msg[] = [];
    const a = createTransportBridge(transport, () => {});
    const b = createTransportBridge(transport, (m) => seen.push(m));
    b.close();
    b.close(); // idempotent
    a.publish({ n: 1 });
    expect(seen).toEqual([]);
  });

  it("logs synchronous publish failures instead of throwing", () => {
    const errors: unknown[][] = [];
    const broken: Transport<Msg> = {
      publish() {
        throw new Error("broker down");
      },
      subscribe: () => () => {},
    };
    const bridge = createTransportBridge(broken, () => {}, {
      label: "[test]",
      logger: { error: (...args: unknown[]) => void errors.push(args) },
    });
    expect(() => bridge.publish({ n: 1 })).not.toThrow();
    expect(errors[0]?.[0]).toEqual("[test] transport publish failed:");
  });

  it("logs rejected async publishes", async () => {
    const errors: unknown[] = [];
    const broken: Transport<Msg> = {
      publish: () => Promise.reject(new Error("timeout")),
      subscribe: () => () => {},
    };
    const bridge = createTransportBridge(broken, () => {}, {
      logger: { error: (...args: unknown[]) => void errors.push(args) },
    });
    bridge.publish({ n: 1 });
    await Bun.sleep(0);
    expect(errors).toHaveLength(1);
  });

  it("a throwing remote handler is contained and logged", () => {
    const transport = createMemoryTransport<Msg>();
    const errors: unknown[] = [];
    const a = createTransportBridge(transport, () => {}, { logger: silent });
    createTransportBridge(
      transport,
      () => {
        throw new Error("bad handler");
      },
      { logger: { error: (...args: unknown[]) => void errors.push(args) } },
    );
    expect(() => a.publish({ n: 1 })).not.toThrow();
    expect(errors).toHaveLength(1);
  });
});

describe("createMemoryTransport", () => {
  it("delivers a JSON copy, not the original object", () => {
    const transport = createMemoryTransport<Msg & { obj: { x: number } }>();
    let received: unknown;
    transport.subscribe((m) => {
      received = m;
    });
    const sent = { origin: "o", n: 1, obj: { x: 1 } };
    transport.publish(sent);
    expect(received).toEqual(sent);
    expect(received).not.toBe(sent);
  });

  it("rejects non-serializable payloads like a real broker", () => {
    const transport = createMemoryTransport<
      TransportEnvelope & { n: bigint }
    >();
    expect(() => transport.publish({ origin: "o", n: 1n })).toThrow();
  });
});
