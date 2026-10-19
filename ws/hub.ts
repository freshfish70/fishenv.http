/**
 * Keyed registry of live sockets plus server-side rooms — the seam for
 * targeted (non-broadcast) sends from anywhere in the application.
 */

import type { Server } from "bun";
import type { AnyChannelContract } from "../contract/index.ts";
import {
  createTransportBridge,
  type SocketData,
  type Transport,
  type TransportBridge,
  type TransportEnvelope,
} from "../core/index.ts";
import { WsChannelTarget } from "./channels/target.ts";
import type { WsConnection } from "./connection.ts";
import { WsCloseCode } from "./types.ts";

/** Anything a hub can deliver: text and binary go out as-is, the rest as JSON. */
export type WsHubPayload = unknown;

/** Serializable form of a {@link RoomFilter}. */
export interface WireFilter {
  exceptIds?: string[];
  exceptKeys?: string[];
  onlyKeys?: string[];
}

/**
 * Cross-process envelope for hub operations. One transport instance can be
 * shared by every hub: messages carry the hub name.
 */
export type WsTransportMessage = TransportEnvelope & { hub: string } & (
    | { kind: "send"; key: string | null; payload: WirePayload }
    | { kind: "room"; room: string; payload: WirePayload; filter?: WireFilter }
    | { kind: "close"; key: string; code: number; reason: string }
    | { kind: "kick"; room: string; filter?: WireFilter; reason: string }
    | { kind: "presence"; body: unknown }
  );

/** A pre-encoded payload: text, or base64 for binary frames. */
export interface WirePayload {
  text?: string;
  base64?: string;
}

export interface WsHubOptions {
  /**
   * Namespaces native topics and transport messages. Defaults to the class
   * name — set it explicitly if your build minifies class names.
   */
  name?: string;
  transport?: Transport<WsTransportMessage>;
}

type Frame = string | Uint8Array;

/** Which room members a send/kick applies to. */
export interface RoomFilter {
  exceptIds: ReadonlySet<string>;
  exceptKeys: ReadonlySet<string>;
  /** `null` = every key. */
  onlyKeys: ReadonlySet<string> | null;
}

const NO_FILTER: RoomFilter = {
  exceptIds: new Set(),
  exceptKeys: new Set(),
  onlyKeys: null,
};

function isUnfiltered(filter: RoomFilter): boolean {
  return (
    filter.exceptIds.size === 0 &&
    filter.exceptKeys.size === 0 &&
    filter.onlyKeys == null
  );
}

function toWireFilter(filter: RoomFilter): WireFilter | undefined {
  if (isUnfiltered(filter)) return undefined;
  return {
    exceptIds: filter.exceptIds.size ? [...filter.exceptIds] : undefined,
    exceptKeys: filter.exceptKeys.size ? [...filter.exceptKeys] : undefined,
    onlyKeys: filter.onlyKeys ? [...filter.onlyKeys] : undefined,
  };
}

function fromWireFilter(wire: WireFilter | undefined): RoomFilter {
  if (wire == null) return NO_FILTER;
  return {
    exceptIds: new Set(wire.exceptIds ?? []),
    exceptKeys: new Set(wire.exceptKeys ?? []),
    onlyKeys: wire.onlyKeys ? new Set(wire.onlyKeys) : null,
  };
}

/** A fan-out target: a room, optionally narrowed to/away from sockets or keys. */
export class WsRoomTarget {
  readonly #hub: WsHub;
  readonly #room: string;
  readonly #filter: RoomFilter;

  /** @internal Use `hub.to(room)`. */
  constructor(hub: WsHub, room: string, filter: RoomFilter = NO_FILTER) {
    this.#hub = hub;
    this.#room = room;
    this.#filter = filter;
  }

  /** Exclude a socket (e.g. the sender) or every socket of a key. */
  except(...targets: (WsConnection | string)[]): WsRoomTarget {
    const exceptIds = new Set(this.#filter.exceptIds);
    const exceptKeys = new Set(this.#filter.exceptKeys);
    for (const t of targets) {
      if (typeof t === "string") exceptKeys.add(t);
      else exceptIds.add(t.id);
    }
    return new WsRoomTarget(this.#hub, this.#room, {
      ...this.#filter,
      exceptIds,
      exceptKeys,
    });
  }

  /** Only members registered under one of `keys`. */
  only(...keys: string[]): WsRoomTarget {
    const onlyKeys = new Set(keys);
    if (this.#filter.onlyKeys != null) {
      for (const k of [...onlyKeys]) {
        if (!this.#filter.onlyKeys.has(k)) onlyKeys.delete(k);
      }
    }
    return new WsRoomTarget(this.#hub, this.#room, {
      ...this.#filter,
      onlyKeys,
    });
  }

  /** Deliver to matching members on every node. Returns the local delivery count. */
  send(data: WsHubPayload): number {
    return this.#hub._sendRoom(
      this.#room,
      encodeFrame(data),
      this.#filter,
      true,
    );
  }

  /**
   * Remove matching members from the room on every node, running any leave
   * hook registered for them (channels use this to notify the client).
   */
  kick(reason = ""): number {
    return this.#hub._kick(this.#room, this.#filter, reason, true);
  }

  /** Local matching member count. */
  count(): number {
    return this.sockets().length;
  }

  /** Local matching members. */
  sockets(): WsConnection[] {
    return this.#hub._members(this.#room, this.#filter);
  }
}

/**
 * Sockets keyed by an application identity (user id, tenant id, device…),
 * plus server-side **rooms** — groupings the server assigns; clients can't
 * ask to join one. One key maps to many sockets (tabs); one socket has at
 * most one key and any number of rooms.
 *
 * Subclass it to get a DI token:
 * ```ts
 * class ChatSockets extends WsHub {}
 * ```
 */
export class WsHub {
  readonly name: string;
  readonly #byKey = new Map<string, Set<WsConnection>>();
  readonly #keyOf = new Map<WsConnection, string>();
  readonly #rooms = new Map<string, Set<WsConnection>>();
  readonly #roomsOf = new Map<WsConnection, Set<string>>();
  readonly #tracked = new Set<WsConnection>();
  readonly #leaveHooks = new Map<
    WsConnection,
    Map<string, (reason: string) => void>
  >();
  readonly #extensions = new Map<string, (body: unknown) => void>();
  readonly #bridge: TransportBridge<WsTransportMessage>;

  constructor(options: WsHubOptions = {}) {
    this.name = options.name ?? this.constructor.name;
    this.#bridge = createTransportBridge(
      options.transport,
      (message) => {
        if (message.hub === this.name) this.#onRemote(message);
      },
      { label: "[fishenv.ws]" },
    );
  }

  /** Random id of this hub instance on the transport. */
  get nodeId(): string {
    return this.#bridge.nodeId;
  }

  // ── Registration ────────────────────────────────────────────────────

  /**
   * Register a socket under `key`. Returns an unregister fn; also
   * auto-removes (keys and rooms) on close. Re-adding moves the socket.
   */
  add(key: string, socket: WsConnection): () => void {
    if (socket.closed) return () => {};
    this.#removeKey(socket);
    let set = this.#byKey.get(key);
    if (set == null) {
      set = new Set();
      this.#byKey.set(key, set);
    }
    set.add(socket);
    this.#keyOf.set(socket, key);
    this.#track(socket);
    return () => {
      if (this.#keyOf.get(socket) === key) this.#removeKey(socket);
    };
  }

  /** The key a socket was registered under, if any. */
  keyOf(socket: WsConnection): string | undefined {
    return this.#keyOf.get(socket);
  }

  // ── Rooms ───────────────────────────────────────────────────────────

  /** Put a socket in a room (idempotent). Server-side only. */
  join(socket: WsConnection, room: string): void {
    if (socket.closed) return;
    let members = this.#rooms.get(room);
    if (members == null) {
      members = new Set();
      this.#rooms.set(room, members);
    }
    if (members.has(socket)) return;
    members.add(socket);
    let rooms = this.#roomsOf.get(socket);
    if (rooms == null) {
      rooms = new Set();
      this.#roomsOf.set(socket, rooms);
    }
    rooms.add(room);
    if (serverOf(socket) != null) socket.raw.subscribe(this.#topic(room));
    this.#track(socket);
  }

  /** Remove a socket from a room. Does *not* run leave hooks. */
  leave(socket: WsConnection, room: string): void {
    this.#leaveHooks.get(socket)?.delete(room);
    const members = this.#rooms.get(room);
    if (members == null || !members.delete(socket)) return;
    if (members.size === 0) this.#rooms.delete(room);
    const rooms = this.#roomsOf.get(socket);
    rooms?.delete(room);
    if (rooms?.size === 0) this.#roomsOf.delete(socket);
    if (!socket.closed && serverOf(socket) != null) {
      socket.raw.unsubscribe(this.#topic(room));
    }
  }

  /** Rooms a socket is in. */
  rooms(socket: WsConnection): string[] {
    return [...(this.#roomsOf.get(socket) ?? [])];
  }

  /** Every room with at least one local member. */
  roomNames(): string[] {
    return [...this.#rooms.keys()];
  }

  to(room: string): WsRoomTarget {
    return new WsRoomTarget(this, room);
  }

  /**
   * A concrete channel of a `channels()` handler mounted with this hub.
   * Pass the contract for typed server events: `hub.channel(room, "rooms/42")`.
   */
  channel(name: string): WsChannelTarget;
  channel<C extends AnyChannelContract>(
    contract: C,
    name: string,
  ): WsChannelTarget<C>;
  channel(a: string | AnyChannelContract, b?: string): WsChannelTarget {
    return new WsChannelTarget(this, typeof a === "string" ? a : (b ?? ""));
  }

  // ── Sending ─────────────────────────────────────────────────────────

  /** Send to every socket of `key` on every node. Returns local delivery count. */
  send(key: string, data: WsHubPayload): number {
    const frame = encodeFrame(data);
    this.#bridge.publish({
      hub: this.name,
      kind: "send",
      key,
      payload: toWire(frame),
    });
    return this.#deliverKey(key, frame);
  }

  sendMany(keys: Iterable<string>, data: WsHubPayload): number {
    let delivered = 0;
    for (const key of keys) delivered += this.send(key, data);
    return delivered;
  }

  /** Send to every keyed socket in this hub, on every node. */
  broadcast(data: WsHubPayload): number {
    const frame = encodeFrame(data);
    this.#bridge.publish({
      hub: this.name,
      kind: "send",
      key: null,
      payload: toWire(frame),
    });
    return this.#deliverAll(frame);
  }

  /**
   * Close every socket of `key` on every node — e.g. on logout or when
   * permissions are revoked. Returns the local count.
   */
  close(key: string, code: number = WsCloseCode.Normal, reason = ""): number {
    this.#bridge.publish({ hub: this.name, kind: "close", key, code, reason });
    return this.#closeKey(key, code, reason);
  }

  /** Close every local socket and detach from the transport. */
  closeAll(code: number = WsCloseCode.GoingAway, reason = ""): void {
    for (const socket of [...this.#tracked]) socket.close(code, reason);
    this.#bridge.close();
  }

  // ── Introspection ───────────────────────────────────────────────────

  has(key: string): boolean {
    return (this.#byKey.get(key)?.size ?? 0) > 0;
  }

  /** Socket count for `key`, or every keyed socket when omitted. */
  count(key?: string): number {
    if (key != null) return this.#byKey.get(key)?.size ?? 0;
    return this.#keyOf.size;
  }

  keys(): string[] {
    return [...this.#byKey.keys()];
  }

  connections(key: string): WsConnection[] {
    return [...(this.#byKey.get(key) ?? [])];
  }

  // ── Extension points (channels, presence) ───────────────────────────

  /**
   * @internal Run `hook` when `socket` is kicked from `room` (locally or by
   * another node). The hook is responsible for calling `leave()`.
   */
  _onLeave(
    socket: WsConnection,
    room: string,
    hook: (reason: string) => void,
  ): void {
    let hooks = this.#leaveHooks.get(socket);
    if (hooks == null) {
      hooks = new Map();
      this.#leaveHooks.set(socket, hooks);
    }
    hooks.set(room, hook);
  }

  /** @internal Receive transport messages of an extension (e.g. presence). */
  _registerExtension(
    kind: "presence",
    onRemote: (body: unknown) => void,
  ): void {
    this.#extensions.set(kind, onRemote);
  }

  /** @internal Publish an extension message to other nodes. */
  _publishExtension(kind: "presence", body: unknown): void {
    this.#bridge.publish({ hub: this.name, kind, body });
  }

  /** @internal */
  _members(room: string, filter: RoomFilter = NO_FILTER): WsConnection[] {
    return [...(this.#rooms.get(room) ?? [])].filter((s) =>
      this.#matches(s, filter),
    );
  }

  /** @internal */
  _sendRoom(
    room: string,
    frame: Frame,
    filter: RoomFilter,
    publish: boolean,
  ): number {
    if (publish) {
      this.#bridge.publish({
        hub: this.name,
        kind: "room",
        room,
        payload: toWire(frame),
        filter: toWireFilter(filter),
      });
    }

    const members = this.#rooms.get(room);
    if (members == null) return 0;

    // Fast path: no filter → one native publish per server.
    if (isUnfiltered(filter)) {
      const servers = new Set<Server<SocketData>>();
      let delivered = 0;
      for (const socket of members) {
        if (socket.closed) continue;
        const server = serverOf(socket);
        if (server == null) {
          if (isDelivered(socket.send(frame))) delivered++;
        } else {
          servers.add(server);
          delivered++;
        }
      }
      for (const server of servers) server.publish(this.#topic(room), frame);
      return delivered;
    }

    let delivered = 0;
    for (const socket of [...members]) {
      if (!this.#matches(socket, filter)) continue;
      if (isDelivered(socket.send(frame))) delivered++;
    }
    return delivered;
  }

  /** @internal */
  _kick(
    room: string,
    filter: RoomFilter,
    reason: string,
    publish: boolean,
  ): number {
    if (publish) {
      this.#bridge.publish({
        hub: this.name,
        kind: "kick",
        room,
        filter: toWireFilter(filter),
        reason,
      });
    }
    const targets = this._members(room, filter);
    for (const socket of targets) {
      const hook = this.#leaveHooks.get(socket)?.get(room);
      if (hook != null) hook(reason);
      else this.leave(socket, room);
    }
    return targets.length;
  }

  // ── Internals ───────────────────────────────────────────────────────

  #matches(socket: WsConnection, filter: RoomFilter): boolean {
    if (filter.exceptIds.has(socket.id)) return false;
    const key = this.#keyOf.get(socket);
    if (key != null && filter.exceptKeys.has(key)) return false;
    if (filter.onlyKeys != null && (key == null || !filter.onlyKeys.has(key))) {
      return false;
    }
    return true;
  }

  #topic(room: string): string {
    return `fx:${this.name}:r:${room}`;
  }

  #deliverKey(key: string, frame: Frame): number {
    let delivered = 0;
    for (const socket of [...(this.#byKey.get(key) ?? [])]) {
      if (isDelivered(socket.send(frame))) delivered++;
    }
    return delivered;
  }

  #deliverAll(frame: Frame): number {
    let delivered = 0;
    for (const socket of [...this.#keyOf.keys()]) {
      if (isDelivered(socket.send(frame))) delivered++;
    }
    return delivered;
  }

  #closeKey(key: string, code: number, reason: string): number {
    const sockets = [...(this.#byKey.get(key) ?? [])];
    for (const socket of sockets) socket.close(code, reason);
    return sockets.length;
  }

  #onRemote(message: WsTransportMessage): void {
    switch (message.kind) {
      case "send": {
        const frame = fromWire(message.payload);
        if (message.key == null) this.#deliverAll(frame);
        else this.#deliverKey(message.key, frame);
        return;
      }
      case "room":
        this._sendRoom(
          message.room,
          fromWire(message.payload),
          fromWireFilter(message.filter),
          false,
        );
        return;
      case "close":
        this.#closeKey(message.key, message.code, message.reason);
        return;
      case "kick":
        this._kick(
          message.room,
          fromWireFilter(message.filter),
          message.reason,
          false,
        );
        return;
      case "presence":
        this.#extensions.get("presence")?.(message.body);
        return;
    }
  }

  #track(socket: WsConnection): void {
    if (this.#tracked.has(socket)) return;
    this.#tracked.add(socket);
    socket.onClose(() => {
      this.#tracked.delete(socket);
      this.#removeKey(socket);
      for (const room of this.rooms(socket)) this.leave(socket, room);
      this.#leaveHooks.delete(socket);
    });
  }

  #removeKey(socket: WsConnection): void {
    const key = this.#keyOf.get(socket);
    if (key == null) return;
    this.#keyOf.delete(socket);
    const set = this.#byKey.get(key);
    set?.delete(socket);
    if (set?.size === 0) this.#byKey.delete(key);
  }
}

function serverOf(socket: WsConnection): Server<SocketData> | undefined {
  return (socket.raw.data as SocketData | undefined)?.server;
}

function isDelivered(result: string): boolean {
  return result === "sent" || result === "backpressure";
}

/** Text and binary frames go out as-is; everything else as JSON. */
export function encodeFrame(data: WsHubPayload): Frame {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return JSON.stringify(data);
}

function toWire(frame: Frame): WirePayload {
  return typeof frame === "string"
    ? { text: frame }
    : { base64: Buffer.from(frame).toString("base64") };
}

function fromWire(payload: WirePayload): Frame {
  if (payload.text != null) return payload.text;
  return new Uint8Array(Buffer.from(payload.base64 ?? "", "base64"));
}
