/**
 * Server-side access to a concrete channel (`rooms/42`) from anywhere —
 * use cases, jobs, webhooks — via the hub the channels are mounted with.
 */

import type { AnyChannelContract } from "../../contract/index.ts";
import type { WsConnection } from "../connection.ts";
import type { WsHub, WsRoomTarget } from "../hub.ts";
import type { PresenceTopic } from "../presence.ts";
import type { ServerEventName, ServerEventPayload } from "./channel.ts";
import { eventFrame } from "./protocol.ts";

/**
 * Hub room backing a channel. The control-character prefix can't collide
 * with client-supplied channel names (which reject control characters) or
 * with ordinary server-side rooms.
 */
export function channelRoom(name: string): string {
  return `\u0001ch:${name}`;
}

export class WsChannelTarget<C = AnyChannelContract> {
  readonly name: string;
  readonly #hub: WsHub;
  readonly #room: WsRoomTarget;

  /** @internal Use `hub.channel(name)`. */
  constructor(hub: WsHub, name: string, room?: WsRoomTarget) {
    this.name = name;
    this.#hub = hub;
    this.#room = room ?? hub.to(channelRoom(name));
  }

  /** Who is in this channel, cluster-wide (contracts with `.presence()`). */
  get presence(): PresenceTopic {
    return this.#hub.presence(channelRoom(this.name));
  }

  /** Push an event to matching members on every node. Returns the local count. */
  send<E extends ServerEventName<C>>(
    event: E,
    payload: ServerEventPayload<C, E>,
  ): number {
    return this.#room.send(eventFrame(this.name, event, payload));
  }

  /** Only sockets registered under these hub keys (e.g. user ids). */
  to(...keys: string[]): WsChannelTarget<C> {
    return this.#derive(this.#room.only(...keys));
  }

  except(...targets: (WsConnection | string)[]): WsChannelTarget<C> {
    return this.#derive(this.#room.except(...targets));
  }

  /**
   * Remove matching members on every node. Their `.leave()` handlers run
   * with reason `"kicked"` and the client receives `{ t: "close" }`.
   */
  kick(reason = ""): number {
    return this.#room.kick(reason);
  }

  /** Local matching member count. */
  count(): number {
    return this.#room.count();
  }

  sockets(): WsConnection[] {
    return this.#room.sockets();
  }

  #derive(room: WsRoomTarget): WsChannelTarget<C> {
    return new WsChannelTarget<C>(this.#hub, this.name, room);
  }
}
