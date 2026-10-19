/**
 * `channel()` — the server-side implementation of a channel, either from a
 * shared `c.channel()` contract or defined inline.
 *
 * ```ts
 * const roomImpl = channel(contract.room)
 *   .join(async ({ ctx, path, data }) => ({ history: await load(path.roomId) }))
 *   .on("message", async ({ data, channel }) => {
 *     channel.broadcast("message", saved);
 *     return { id: saved.id };
 *   });
 * ```
 *
 * Builders are immutable. The type parameters track which client events have
 * handlers and whether an authorizer exists, so `.channels([...])` rejects
 * incomplete implementations at compile time (and again at `build()`).
 */

import type * as v from "valibot";
import {
  type AnyChannelContract,
  ChannelContract,
  type InferChannel,
} from "../../contract/index.ts";
import {
  type AnySchema,
  buildRouteRegex,
  type DIContainer,
} from "../../core/index.ts";
import type { WsConnection } from "../connection.ts";
import type { WsSendResult } from "../types.ts";

type Shape<C> = InferChannel<C>;
type MaybePromise<T> = T | Promise<T>;

export type ClientEventName<C> = keyof Shape<C>["clientEvents"] & string;
type ServerEvents<C> = Shape<C>["serverEvents"];

/** Declared server events, or any name when the contract declares none (inline). */
export type ServerEventName<C> = [keyof ServerEvents<C>] extends [never]
  ? string
  : keyof ServerEvents<C> & string;

export type ServerEventPayload<C, E> = E extends keyof ServerEvents<C>
  ? ServerEvents<C>[E]["payloadIn"]
  : unknown;

/** Why a channel was left; passed to `.leave()` handlers. */
export type LeaveReason = "client" | "disconnect" | "kicked" | "server";

type PresenceMetaIn<C> = [Shape<C>["presenceMeta"]] extends [never]
  ? never
  : Shape<C>["presenceMeta"] extends { in: infer M }
    ? M
    : never;

/** Presence of the current channel, from a handler's point of view. */
export interface ChannelPresence<M> {
  /** Change the current socket's meta (it must be tracked). */
  update(meta: M): boolean;
  /** Cluster-wide `{ [key]: { ref, meta }[] }`. */
  list(): Record<string, { ref: string; meta: M }[]>;
  has(key: string): boolean;
  keys(): string[];
}

/** The `channel` argument of every handler: actions scoped to this channel. */
export interface ChannelContext<C> {
  /** Only on channels whose contract declares `.presence()`. */
  readonly presence: [PresenceMetaIn<C>] extends [never]
    ? undefined
    : ChannelPresence<PresenceMetaIn<C>>;
  /** Concrete channel name, e.g. `rooms/42`. */
  readonly name: string;
  /** Everyone in the channel on every node, including the sender. */
  broadcast<E extends ServerEventName<C>>(
    event: E,
    payload: ServerEventPayload<C, E>,
  ): number;
  /** Everyone except the current socket. */
  broadcastFrom<E extends ServerEventName<C>>(
    event: E,
    payload: ServerEventPayload<C, E>,
  ): number;
  /** Only the current socket. */
  push<E extends ServerEventName<C>>(
    event: E,
    payload: ServerEventPayload<C, E>,
  ): WsSendResult;
  /** Server-initiated leave for the current socket. */
  leave(reason?: string): void;
}

export interface ChannelHandlerArgs<Ctx, C> {
  ctx: Ctx;
  /** Channel-name params, validated by the contract's `.param()` schemas. */
  path: Shape<C>["params"];
  socket: WsConnection;
  /** The upgrade request. */
  req: Request;
  container: DIContainer;
  channel: ChannelContext<C>;
}

type ReplyOf<R> = [R] extends [undefined] ? unknown : R;

export type JoinFn<Ctx, C> = (
  args: ChannelHandlerArgs<Ctx, C> & { data: Shape<C>["join"]["payload"] },
) => MaybePromise<ReplyOf<Shape<C>["join"]["replyIn"]>>;

export type EventFn<Ctx, C, E extends ClientEventName<C>> = (
  args: ChannelHandlerArgs<Ctx, C> & {
    data: Shape<C>["clientEvents"][E]["payload"];
  },
) => MaybePromise<ReplyOf<Shape<C>["clientEvents"][E]["replyIn"]>>;

export type AnyEventFn<Ctx, C> = (
  args: ChannelHandlerArgs<Ctx, C> & { event: string; data: unknown },
) => unknown;

/**
 * Decide how the joining socket appears in presence: return its key (e.g.
 * the user id) and meta, or `null` to join without being tracked.
 */
export type PresenceFn<Ctx, C> = (
  args: ChannelHandlerArgs<Ctx, C> & { data: Shape<C>["join"]["payload"] },
) => MaybePromise<{ key: string; meta: PresenceMetaIn<C> } | null | undefined>;

export type LeaveFn<Ctx, C> = (
  args: Omit<ChannelHandlerArgs<Ctx, C>, "channel"> & { reason: LeaveReason },
) => unknown;

/** Runtime data of a channel implementation. */
export interface ChannelImplDefinition {
  contract: AnyChannelContract;
  pattern: RegExp;
  paramNames: string[];
  inline: boolean;
  isPublic: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: erased handler types
  join?: (args: any) => unknown;
  // biome-ignore lint/suspicious/noExplicitAny: erased handler types
  events: Map<string, (args: any) => unknown>;
  // biome-ignore lint/suspicious/noExplicitAny: erased handler types
  any?: (args: any) => unknown;
  // biome-ignore lint/suspicious/noExplicitAny: erased handler types
  leave?: (args: any) => unknown;
  // biome-ignore lint/suspicious/noExplicitAny: erased handler types
  presence?: (args: any) => unknown;
}

type Status<Missing, Joined> = [Missing] extends [never]
  ? Joined extends true
    ? "complete"
    : "missing .join() or .public()"
  : `missing .on("${Missing & string}")`;

export class ChannelImpl<
  Ctx,
  C extends AnyChannelContract,
  Handled extends string = never,
  Joined extends boolean = false,
> {
  /** @internal Phantom: makes `Ctx` contravariant for `.channels()` checks. */
  declare readonly _ctx?: (ctx: Ctx) => void;
  /** @internal Phantom: `"complete"` once every event is handled and joins are authorized. */
  declare readonly _status?: Status<
    Exclude<ClientEventName<C>, Handled>,
    Joined
  >;

  readonly contract: C;
  readonly #def: ChannelImplDefinition;

  /** @internal Use {@link channel}. */
  constructor(contract: C, def?: Partial<ChannelImplDefinition>) {
    this.contract = contract;
    const { regex, paramNames } = buildRouteRegex(`/${contract.name}`);
    this.#def = {
      contract,
      pattern: regex,
      paramNames,
      inline: false,
      isPublic: false,
      events: new Map(),
      ...def,
    };
  }

  get _definition(): ChannelImplDefinition {
    return this.#def;
  }

  #next<R>(
    patch: Partial<ChannelImplDefinition>,
    contract?: AnyChannelContract,
  ): R {
    return new ChannelImpl(contract ?? this.contract, {
      ...this.#def,
      events: new Map(this.#def.events),
      ...patch,
      ...(contract ? { contract } : {}),
    }) as R;
  }

  /** Re-type the handler context, e.g. `channel(room).context<AppCtx>()`. */
  context<NewCtx>(): ChannelImpl<NewCtx, C, Handled, Joined> {
    return this as unknown as ChannelImpl<NewCtx, C, Handled, Joined>;
  }

  /** Inline channels only: narrow/coerce a channel-name param. */
  param<Name extends string & keyof Shape<C>["params"], S extends AnySchema>(
    name: Name,
    schema: S,
  ): ChannelImpl<Ctx, ParamResult<C, Name, S>, Handled, Joined> {
    this.#assertInline("param");
    return this.#next({}, this.contract.param(name, schema));
  }

  /**
   * The join authorizer — throw (e.g. `ForbiddenError`) to refuse. The return
   * value is the join reply. Inline channels may pass a payload schema first.
   */
  join(fn: JoinFn<Ctx, C>): ChannelImpl<Ctx, C, Handled, true>;
  join<S extends AnySchema>(
    payload: S,
    fn: JoinFn<Ctx, JoinResult<C, S>>,
  ): ChannelImpl<Ctx, JoinResult<C, S>, Handled, true>;
  // biome-ignore lint/suspicious/noExplicitAny: overload implementation
  join(a: any, b?: any): any {
    if (b === undefined) return this.#next({ join: a });
    this.#assertInline("join(schema, fn)");
    return this.#next({ join: b }, this.contract.join(a));
  }

  /** Explicitly allow joining without authorization. */
  public(): ChannelImpl<Ctx, C, Handled, true> {
    return this.#next({ isPublic: true });
  }

  /**
   * Handle a client event. The return value is the reply (sent when the
   * client passed a `ref`). Inline channels pass the payload schema second.
   */
  on<E extends ClientEventName<C>>(
    event: E,
    fn: EventFn<Ctx, C, E>,
  ): ChannelImpl<Ctx, C, Handled | E, Joined>;
  on<E extends string, S extends AnySchema>(
    event: E,
    payload: S,
    fn: EventFn<
      Ctx,
      EventResult<C, E, S>,
      E & ClientEventName<EventResult<C, E, S>>
    >,
  ): ChannelImpl<Ctx, EventResult<C, E, S>, Handled | E, Joined>;
  // biome-ignore lint/suspicious/noExplicitAny: overload implementation
  on(event: string, a: any, b?: any): any {
    if (this.#def.events.has(event)) {
      throw new Error(
        `${this.contract.name}: .on("${event}") is already defined`,
      );
    }
    if (b === undefined) {
      if (!this.contract._definition.clientEvents.has(event)) {
        throw new Error(
          `${this.contract.name}: "${event}" is not a client event of the contract`,
        );
      }
      const events = new Map(this.#def.events);
      events.set(event, a);
      return this.#next({ events });
    }
    this.#assertInline(`on("${event}", schema, fn)`);
    const events = new Map(this.#def.events);
    events.set(event, b);
    return this.#next({ events }, this.contract.clientEvent(event, a));
  }

  /**
   * Catch-all for events without a handler — unvalidated, for proxies and
   * bridges. Undeclared events are otherwise rejected with `unknown_event`.
   */
  onAny(fn: AnyEventFn<Ctx, C>): ChannelImpl<Ctx, C, Handled, Joined> {
    return this.#next({ any: fn });
  }

  /**
   * Track joining sockets in presence (contract must declare `.presence()`).
   * Untracked automatically on leave, kick and disconnect.
   */
  presence(fn: PresenceFn<Ctx, C>): ChannelImpl<Ctx, C, Handled, Joined> {
    if (this.contract._definition.presence == null) {
      throw new Error(
        `${this.contract.name}: .presence() requires presence in the channel contract`,
      );
    }
    return this.#next({ presence: fn });
  }

  /** Runs when the socket leaves for any reason (client, disconnect, kick). */
  leave(fn: LeaveFn<Ctx, C>): ChannelImpl<Ctx, C, Handled, Joined> {
    return this.#next({ leave: fn });
  }

  #assertInline(what: string): void {
    if (!this.#def.inline) {
      throw new Error(
        `${this.contract.name}: ${what} is only available on inline channels — the contract defines it`,
      );
    }
  }
}

type ParamResult<C, Name extends string, S extends AnySchema> =
  C extends ChannelContract<
    infer N,
    infer P,
    infer J,
    infer CE,
    infer SE,
    infer PM
  >
    ? ChannelContract<
        N,
        Omit<P, Name> & Record<Name, v.InferOutput<S>>,
        J,
        CE,
        SE,
        PM
      >
    : never;

type JoinResult<C, S extends AnySchema> =
  C extends ChannelContract<
    infer N,
    infer P,
    infer _J,
    infer CE,
    infer SE,
    infer PM
  >
    ? ChannelContract<N, P, { payload: S; reply: undefined }, CE, SE, PM>
    : never;

type EventResult<C, E extends string, S extends AnySchema> =
  C extends ChannelContract<
    infer N,
    infer P,
    infer J,
    infer CE,
    infer SE,
    infer PM
  >
    ? ChannelContract<
        N,
        P,
        J,
        CE & Record<E, { payload: S; reply: undefined }>,
        SE,
        PM
      >
    : never;

// biome-ignore lint/suspicious/noExplicitAny: matches any implementation
export type AnyChannelImpl = ChannelImpl<any, AnyChannelContract, any, any>;

export interface ChannelFactory<Ctx> {
  /** Implement a shared `c.channel()` contract. */
  <C extends AnyChannelContract>(contract: C): ChannelImpl<Ctx, C>;
  /** Define a channel inline (router path syntax, e.g. `rooms/:roomId`). */
  <N extends string>(name: N): ChannelImpl<Ctx, ChannelContract<N>>;
}

function createFactory<Ctx>(): ChannelFactory<Ctx> {
  return ((source: string | AnyChannelContract) =>
    typeof source === "string"
      ? new ChannelImpl(new ChannelContract(source), { inline: true })
      : new ChannelImpl(source)) as ChannelFactory<Ctx>;
}

/**
 * Create a channel implementation. Handler `ctx` is untyped by default; use
 * `channel.withContext<AppCtx>()` (or `.context<AppCtx>()`) to type it, or
 * the factory passed to `.channels((channel) => [...])`.
 */
export const channel: ChannelFactory<Record<string, unknown>> & {
  withContext<Ctx>(): ChannelFactory<Ctx>;
} = Object.assign(createFactory<Record<string, unknown>>(), {
  withContext: <Ctx>() => createFactory<Ctx>(),
});
