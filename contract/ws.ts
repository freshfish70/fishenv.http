/**
 * WebSocket contracts — portable data describing sockets and channels, shared
 * by the server (`@fishenv/http/ws`) and typed clients.
 *
 * ```ts
 * export const room = c
 *   .channel("rooms/:roomId")
 *   .param("roomId", v.pipe(v.string(), v.uuid()))
 *   .join(JoinPayload, JoinReply, [ForbiddenError])
 *   .clientEvent("message", MessageIn, MessageAck)
 *   .serverEvent("message", Message)
 *   .presence(PresenceMeta, { clientUpdates: true });
 *
 * export const socket = c.ws("/socket").channels(room);
 * ```
 *
 * Like HTTP contracts, builders are immutable and expose a plain
 * `_definition` snapshot; the compile-time shape is recovered with
 * {@link InferChannel} / {@link InferSocket}.
 */

import type * as v from "valibot";
import type {
  AnySchema,
  BasePathParams,
  MergeParam,
  RouteMeta,
} from "./types.ts";

/**
 * Error classes a handler may throw — documentation and client typing only,
 * like `.output(schema, errors)`. `any[]` so that HTTP error classes with
 * typed constructor params (`ForbiddenError(message?: string)`) fit.
 */
// biome-ignore lint/suspicious/noExplicitAny: constructor params are contravariant
export type ErrorTypes = (abstract new (...args: any[]) => Error)[];

/** The channel protocol's subprotocol name. */
export const CHANNELS_PROTOCOL = "fishenv.channels.v1";

type Maybe<S> = S extends AnySchema ? S : undefined;

/** What the sender passes in (before schema transforms). */
export type SchemaInput<S> = S extends AnySchema ? v.InferInput<S> : undefined;
/** What the receiver gets (after validation and transforms). */
export type SchemaOutput<S> = S extends AnySchema
  ? v.InferOutput<S>
  : undefined;

// ── Channel contract ─────────────────────────────────────────────────────

export interface EventSchemas {
  payload: AnySchema;
  reply: AnySchema | undefined;
}

export interface JoinSchemas {
  payload: AnySchema | undefined;
  reply: AnySchema | undefined;
}

export interface ChannelEventDefinition {
  payload: AnySchema;
  reply?: AnySchema;
  errors?: ErrorTypes;
}

export interface ChannelContractDefinition {
  /** Pattern using router path syntax, e.g. `rooms/:roomId`. */
  name: string;
  paramSchemas: Map<string, AnySchema>;
  join: { payload?: AnySchema; reply?: AnySchema; errors?: ErrorTypes };
  clientEvents: Map<string, ChannelEventDefinition>;
  serverEvents: Map<string, AnySchema>;
  presence?: { meta: AnySchema; clientUpdates: boolean };
  meta?: RouteMeta;
}

export class ChannelContract<
  N extends string,
  Params extends Record<string, unknown> = BasePathParams<N>,
  J extends JoinSchemas = { payload: undefined; reply: undefined },
  CE extends Record<string, EventSchemas> = Record<never, never>,
  SE extends Record<string, AnySchema> = Record<never, never>,
  PM extends AnySchema | undefined = undefined,
> {
  readonly name: N;
  readonly #def: ChannelContractDefinition;

  constructor(name: N, def?: ChannelContractDefinition) {
    if (name.startsWith("/")) {
      throw new Error(`Channel name "${name}" must not start with "/"`);
    }
    this.name = name;
    this.#def = def ?? {
      name,
      paramSchemas: new Map(),
      join: {},
      clientEvents: new Map(),
      serverEvents: new Map(),
    };
  }

  #next<R>(patch: Partial<ChannelContractDefinition>): R {
    const def = this.#def;
    return new ChannelContract(this.name, {
      ...def,
      paramSchemas: new Map(def.paramSchemas),
      join: { ...def.join },
      clientEvents: new Map(def.clientEvents),
      serverEvents: new Map(def.serverEvents),
      presence: def.presence ? { ...def.presence } : undefined,
      meta: def.meta ? { ...def.meta } : undefined,
      ...patch,
    }) as R;
  }

  meta(data: RouteMeta): ChannelContract<N, Params, J, CE, SE, PM> {
    return this.#next({ meta: { ...this.#def.meta, ...data } });
  }

  /** Narrow/coerce a channel-name param. */
  param<Name extends string & keyof Params, S extends AnySchema>(
    name: Name,
    schema: S,
  ): ChannelContract<N, MergeParam<Params, Name, S>, J, CE, SE, PM> {
    const paramSchemas = new Map(this.#def.paramSchemas);
    paramSchemas.set(name, schema);
    return this.#next({ paramSchemas });
  }

  /** Join payload, join reply and documented errors. All optional. */
  join<
    P extends AnySchema | undefined = undefined,
    R extends AnySchema | undefined = undefined,
  >(
    payload?: P,
    reply?: R,
    errors?: ErrorTypes,
  ): ChannelContract<
    N,
    Params,
    { payload: Maybe<P>; reply: Maybe<R> },
    CE,
    SE,
    PM
  > {
    return this.#next({ join: { payload, reply, errors } });
  }

  /** Client → server event. Without `reply` it is fire-and-forget. */
  clientEvent<
    E extends string,
    P extends AnySchema,
    R extends AnySchema | undefined = undefined,
  >(
    name: E,
    payload: P,
    reply?: R,
    errors?: ErrorTypes,
  ): ChannelContract<
    N,
    Params,
    J,
    CE & Record<E, { payload: P; reply: Maybe<R> }>,
    SE,
    PM
  > {
    if (this.#def.clientEvents.has(name)) {
      throw new Error(`clientEvent "${name}" is already defined`);
    }
    const clientEvents = new Map(this.#def.clientEvents);
    clientEvents.set(name, { payload, reply, errors });
    return this.#next({ clientEvents });
  }

  /** Server → client event. */
  serverEvent<E extends string, P extends AnySchema>(
    name: E,
    payload: P,
  ): ChannelContract<N, Params, J, CE, SE & Record<E, P>, PM> {
    if (this.#def.serverEvents.has(name)) {
      throw new Error(`serverEvent "${name}" is already defined`);
    }
    const serverEvents = new Map(this.#def.serverEvents);
    serverEvents.set(name, payload);
    return this.#next({ serverEvents });
  }

  /**
   * Enable presence for this channel. `clientUpdates` lets clients change
   * their own meta (rate-limited server-side).
   */
  presence<M extends AnySchema>(
    meta: M,
    opts: { clientUpdates?: boolean } = {},
  ): ChannelContract<N, Params, J, CE, SE, M> {
    return this.#next({
      presence: { meta, clientUpdates: opts.clientUpdates ?? false },
    });
  }

  get _definition(): ChannelContractDefinition {
    return this.#def;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: matches any channel contract
export type AnyChannelContract = ChannelContract<any, any, any, any, any, any>;

/** Compile-time shape of a channel contract, from both sides' perspective. */
export type InferChannel<C> =
  C extends ChannelContract<
    infer N,
    infer Params,
    infer J,
    infer CE,
    infer SE,
    infer PM
  >
    ? {
        name: N;
        params: Params;
        join: {
          /** What the client sends / the server receives. */
          payloadIn: SchemaInput<J["payload"]>;
          payload: SchemaOutput<J["payload"]>;
          /** What the server returns / the client receives. */
          replyIn: SchemaInput<J["reply"]>;
          reply: SchemaOutput<J["reply"]>;
        };
        clientEvents: {
          [K in keyof CE]: {
            payloadIn: SchemaInput<CE[K]["payload"]>;
            payload: SchemaOutput<CE[K]["payload"]>;
            replyIn: SchemaInput<CE[K]["reply"]>;
            reply: SchemaOutput<CE[K]["reply"]>;
          };
        };
        serverEvents: {
          [K in keyof SE]: {
            payloadIn: SchemaInput<SE[K]>;
            payload: SchemaOutput<SE[K]>;
          };
        };
        presenceMeta: PM extends AnySchema
          ? { in: SchemaInput<PM>; out: SchemaOutput<PM> }
          : never;
      }
    : never;

// ── Socket contract ──────────────────────────────────────────────────────

export type WsContractKind = "raw" | "messages" | "channels";

export interface WsContractDefinition {
  path: string;
  paramSchemas: Map<string, AnySchema>;
  kind: WsContractKind;
  protocols?: string[];
  channels: AnyChannelContract[];
  messages?: { client: AnySchema; server: AnySchema };
  meta?: RouteMeta;
}

export class WsContract<
  P extends string,
  Params extends Record<string, unknown> = BasePathParams<P>,
  K extends WsContractKind = "raw",
  Channels extends readonly AnyChannelContract[] = [],
  Client extends AnySchema | undefined = undefined,
  Server extends AnySchema | undefined = undefined,
> {
  readonly path: P;
  readonly #def: WsContractDefinition;

  constructor(path: P, def?: WsContractDefinition) {
    this.path = path;
    this.#def = def ?? {
      path,
      paramSchemas: new Map(),
      kind: "raw",
      channels: [],
    };
  }

  #next<R>(patch: Partial<WsContractDefinition>): R {
    const def = this.#def;
    return new WsContract(this.path, {
      ...def,
      paramSchemas: new Map(def.paramSchemas),
      channels: [...def.channels],
      protocols: def.protocols ? [...def.protocols] : undefined,
      ...patch,
    }) as R;
  }

  meta(data: RouteMeta): WsContract<P, Params, K, Channels, Client, Server> {
    return this.#next({ meta: { ...this.#def.meta, ...data } });
  }

  param<Name extends string & keyof Params, S extends AnySchema>(
    name: Name,
    schema: S,
  ): WsContract<P, MergeParam<Params, Name, S>, K, Channels, Client, Server> {
    const paramSchemas = new Map(this.#def.paramSchemas);
    paramSchemas.set(name, schema);
    return this.#next({ paramSchemas });
  }

  /** Subprotocols for raw/message sockets (channels use their own). */
  protocols(
    list: string[],
  ): WsContract<P, Params, K, Channels, Client, Server> {
    return this.#next({ protocols: [...list] });
  }

  /** A typed socket exchanging one JSON message type in each direction. */
  messages<CS extends AnySchema, SS extends AnySchema>(schemas: {
    client: CS;
    server: SS;
  }): WsContract<P, Params, "messages", [], CS, SS> {
    if (this.#def.kind === "channels") {
      throw new Error("messages() and channels() are mutually exclusive");
    }
    return this.#next({ kind: "messages", messages: { ...schemas } });
  }

  /** A socket speaking the channel protocol with exactly these channels. */
  channels<const Cs extends readonly AnyChannelContract[]>(
    ...channels: Cs
  ): WsContract<P, Params, "channels", Cs, undefined, undefined> {
    if (this.#def.kind === "messages") {
      throw new Error("messages() and channels() are mutually exclusive");
    }
    const names = new Set<string>();
    for (const ch of channels) {
      if (names.has(ch.name)) {
        throw new Error(`Channel "${ch.name}" is listed twice`);
      }
      names.add(ch.name);
    }
    return this.#next({
      kind: "channels",
      channels: [...channels],
      protocols: [CHANNELS_PROTOCOL],
    });
  }

  get _definition(): WsContractDefinition {
    return this.#def;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: matches any socket contract
export type AnyWsContract = WsContract<any, any, any, any, any, any>;

export type InferSocket<C> =
  C extends WsContract<
    infer P,
    infer Params,
    infer K,
    infer Channels,
    infer Client,
    infer Server
  >
    ? {
        path: P;
        params: Params;
        kind: K;
        channels: { [I in keyof Channels]: InferChannel<Channels[I]> };
        channelNames: Channels[number]["name"];
        /** Client → server message (raw `messages()` sockets). */
        clientMessageIn: SchemaInput<Client>;
        clientMessage: SchemaOutput<Client>;
        /** Server → client message. */
        serverMessageIn: SchemaInput<Server>;
        serverMessage: SchemaOutput<Server>;
      }
    : never;

export const wsContractFactories = {
  /** A WebSocket endpoint. */
  ws: <P extends string>(path: P) => new WsContract(path),
  /** A channel, named with router path syntax (`rooms/:roomId`). */
  channel: <N extends string>(name: N) => new ChannelContract(name),
};
