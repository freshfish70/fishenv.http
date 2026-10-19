/**
 * Keyed registry of live sockets plus server-side rooms — the seam for
 * targeted (non-broadcast) sends from anywhere in the application.
 */

import type { Server } from "bun";
import {
  createTransportBridge,
  type SocketData,
  type Transport,
  type TransportBridge,
  type TransportEnvelope,
} from "../core/index.ts";
import type { WsConnection } from "./connection.ts";
import { WsCloseCode } from "./types.ts";

/** Anything a hub can deliver: text and binary go out as-is, the rest as JSON. */
export type WsHubPayload = unknown;

/**
 * Cross-process envelope for hub operations. One transport instance can be
 * shared by every hub: messages carry the hub name.
 */
export type WsTransportMessage = TransportEnvelope & { hub: string } & (
    | { kind: "send"; key: string | null; payload: WirePayload }
    | {
        kind: "room";
        room: string;
        payload: WirePayload;
        exceptIds?: string[];
        exceptKeys?: string[];
      }
    | { kind: "close"; key: string; code: number; reason: string }
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

/** A fan-out target: a room, optionally minus some sockets or keys. */
export class WsRoomTarget {
  readonly #hub: WsHub;
  readonly #room: string;
  readonly #exceptIds: ReadonlySet<string>;
  readonly #exceptKeys: ReadonlySet<string>;

  /** @internal Use `hub.to(room)`. */
  constructor(
    hub: WsHub,
    room: string,
    exceptIds: ReadonlySet<string> = new Set(),
    exceptKeys: ReadonlySet<string> = new Set(),
  ) {
    this.#hub = hub;
    this.#room = room;
    this.#exceptIds = exceptIds;
    this.#exceptKeys = exceptKeys;
  }

  /** Exclude a socket (e.g. the sender) or every socket of a key. */
  except(...targets: (WsConnection | string)[]): WsRoomTarget {
    const ids = new Set(this.#exceptIds);
    const keys = new Set(this.#exceptKeys);
    for (const t of targets) {
      if (typeof t === "string") keys.add(t);
      else ids.add(t.id);
    }
    return new WsRoomTarget(this.#hub, this.#room, ids, keys);
  }

  /** Deliver to every member on every node. Returns the local delivery count. */
  send(data: WsHubPayload): number {
    return this.#hub._sendRoom(
      this.#room,
      encodeFrame(data),
      this.#exceptIds,
      this.#exceptKeys,
      true,
    );
  }

  /** Local member count (after exclusions). */
  count(): number {
    return this.sockets().length;
  }

  /** Local members (after exclusions). */
  sockets(): WsConnection[] {
    return this.#hub
      ._members(this.#room)
      .filter(
        (s) =>
          !this.#exceptIds.has(s.id) &&
          !this.#exceptKeys.has(this.#hub.keyOf(s) ?? "\0"),
      );
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

  leave(socket: WsConnection, room: string): void {
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

  // ── Internals ───────────────────────────────────────────────────────

  /** @internal */
  _members(room: string): WsConnection[] {
    return [...(this.#rooms.get(room) ?? [])];
  }

  /** @internal */
  _sendRoom(
    room: string,
    frame: Frame,
    exceptIds: ReadonlySet<string>,
    exceptKeys: ReadonlySet<string>,
    publish: boolean,
  ): number {
    if (publish) {
      this.#bridge.publish({
        hub: this.name,
        kind: "room",
        room,
        payload: toWire(frame),
        exceptIds: exceptIds.size ? [...exceptIds] : undefined,
        exceptKeys: exceptKeys.size ? [...exceptKeys] : undefined,
      });
    }

    const members = this.#rooms.get(room);
    if (members == null) return 0;

    // Fast path: no exclusions → one native publish per server.
    if (exceptIds.size === 0 && exceptKeys.size === 0) {
      const servers = new Set<Server<SocketData>>();
      let delivered = 0;
      for (const socket of members) {
        if (socket.closed) continue;
        const server = serverOf(socket);
        if (server == null) {
          if (socket.send(frame) !== "closed") delivered++;
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
      if (exceptIds.has(socket.id)) continue;
      const key = this.#keyOf.get(socket);
      if (key != null && exceptKeys.has(key)) continue;
      if (isDelivered(socket.send(frame))) delivered++;
    }
    return delivered;
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
          new Set(message.exceptIds ?? []),
          new Set(message.exceptKeys ?? []),
          false,
        );
        return;
      case "close":
        this.#closeKey(message.key, message.code, message.reason);
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
