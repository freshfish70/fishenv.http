/**
 * `channels()` — the opt-in protocol handler. A per-socket state machine
 * that multiplexes authorized channels over one socket.
 *
 * Guarantees:
 * - frames of one socket are processed **sequentially** (join → event →
 *   leave order holds); different sockets run concurrently
 * - nothing reaches a handler before the channel is joined and the payload
 *   validated against the contract
 * - repeated protocol violations close the socket with `1008`
 */

import * as v from "valibot";
import {
  type AnySchema,
  type BuildEnv,
  type DIContainer,
  HttpError,
  type Logger,
  ValidationError,
  validatePathParams,
} from "../../core/index.ts";
import type { WsConnection } from "../connection.ts";
import { type RoomFilter, WsHub } from "../hub.ts";
import { TokenBucket } from "../limits.ts";
import type { PresenceRegistry } from "../presence.ts";
import type {
  WsHandlerArgs,
  WsProtocolHandler,
  WsRouteInfo,
} from "../route-builder.ts";
import { checkOutbound } from "../typed.ts";
import { WsCloseCode, WsCloseError } from "../types.ts";
import type {
  AnyChannelImpl,
  ChannelContext,
  ChannelImplDefinition,
  LeaveReason,
} from "./channel.ts";
import {
  CHANNELS_PROTOCOL,
  type ClientFrame,
  encodeFrame,
  eventFrame,
  FrameError,
  parseClientFrame,
  type WireError,
} from "./protocol.ts";
import { channelRoom } from "./target.ts";

export interface ChannelsOptions {
  /** Default 32. Exceeding it fails the join with `429 too_many_channels`. */
  maxChannelsPerSocket?: number;
  /** Protocol violations tolerated before closing with `1008`. Default 10. */
  maxViolations?: number;
  /** Frames queued behind a slow handler before closing with `1013`. Default 64. */
  maxPendingFrames?: number;
  /**
   * Hub that backs channel membership — pass an instance or a DI token to
   * reach channels from server code via `hub.channel(name)`. A private hub is
   * used otherwise.
   */
  // biome-ignore lint/suspicious/noExplicitAny: DI token constructor
  hub?: WsHub | (abstract new (...args: any[]) => WsHub);
}

const DEFAULTS = {
  maxChannelsPerSocket: 32,
  maxViolations: 10,
  maxPendingFrames: 64,
};

/** Errors for rejected frames, mapped onto the HTTP error vocabulary. */
class ChannelError extends HttpError {
  readonly #code: string;
  /** Counts towards `maxViolations`. */
  readonly violation: boolean;

  constructor(status: number, code: string, message: string, violation = true) {
    super(status, message);
    this.#code = code;
    this.violation = violation;
  }

  override get code(): string {
    return this.#code;
  }
}

interface Joined {
  impl: ChannelImplDefinition;
  name: string;
  path: Record<string, unknown>;
  context: ChannelContext<unknown>;
}

interface RuntimeEnv {
  development: boolean;
  logger: Pick<Logger, "error">;
}

/**
 * Build the protocol handler. Prefer `.channels([...])` on a ws route,
 * which also type-checks completeness; this form plugs into `.handleWith()`.
 */
export function channels(
  impls: readonly AnyChannelImpl[],
  options: ChannelsOptions = {},
): WsProtocolHandler<Record<string, unknown>, Record<string, unknown>> {
  const defs = impls.map((impl) => impl._definition);
  const opts = { ...DEFAULTS, ...options };
  const env: RuntimeEnv = { development: false, logger: console };
  let privateHub: WsHub | undefined;

  const resolveHub = (container: DIContainer): WsHub => {
    const hub = options.hub;
    if (hub instanceof WsHub) return hub;
    if (hub != null) return container.get(hub);
    privateHub ??= new WsHub({
      name: `fishenv.channels.${crypto.randomUUID()}`,
    });
    return privateHub;
  };

  return {
    protocols: [CHANNELS_PROTOCOL],
    onBuild(buildEnv: BuildEnv, route: WsRouteInfo) {
      env.development = buildEnv.development;
      env.logger = buildEnv.logger;
      validateImpls(defs, route);
    },
    setup(args) {
      const session = new ChannelSession(
        args,
        defs,
        resolveHub(args.container),
        opts,
        env,
      );
      args.socket.onMessage((message) => session.enqueue(message.raw));
      args.socket.onClose(() => session.disconnect());
    },
  };
}

/** Startup checks — the runtime twin of the compile-time completeness types. */
function validateImpls(
  defs: ChannelImplDefinition[],
  route: WsRouteInfo,
): void {
  const where = `[fishenv.ws] ${route.path}`;
  const names = new Set<string>();
  for (const def of defs) {
    const name = def.contract.name;
    if (names.has(name))
      throw new Error(`${where}: channel "${name}" is implemented twice`);
    names.add(name);
    if (def.join == null && !def.isPublic) {
      throw new Error(
        `${where}: channel "${name}" has no join authorizer; add .join(fn) or .public()`,
      );
    }
    for (const event of def.contract._definition.clientEvents.keys()) {
      if (!def.events.has(event) && def.any == null) {
        throw new Error(
          `${where}: channel "${name}" is missing .on("${event}")`,
        );
      }
    }
  }

  const contract = route.contract;
  if (contract == null) return;
  if (contract.kind !== "channels") {
    throw new Error(
      `${where}: .channels() requires a c.ws().channels() contract`,
    );
  }
  for (const expected of contract.channels) {
    const def = defs.find((d) => d.contract.name === expected.name);
    if (def == null) {
      throw new Error(
        `${where}: contract channel "${expected.name}" is not implemented`,
      );
    }
    if (def.contract !== expected) {
      throw new Error(
        `${where}: channel "${expected.name}" implements a different contract object than the socket contract lists`,
      );
    }
  }
  for (const def of defs) {
    if (!contract.channels.some((c) => c.name === def.contract.name)) {
      throw new Error(
        `${where}: channel "${def.contract.name}" is not part of the socket contract`,
      );
    }
  }
}

class ChannelSession {
  readonly #args: WsHandlerArgs<
    Record<string, unknown>,
    Record<string, unknown>
  >;
  readonly #socket: WsConnection;
  readonly #defs: ChannelImplDefinition[];
  readonly #hub: WsHub;
  readonly #opts: typeof DEFAULTS;
  readonly #env: RuntimeEnv;
  readonly #joined = new Map<string, Joined>();
  readonly #presenceBuckets = new Map<string, TokenBucket>();
  #chain: Promise<void> = Promise.resolve();
  #pending = 0;
  #violations = 0;
  #disconnected = false;

  constructor(
    args: WsHandlerArgs<Record<string, unknown>, Record<string, unknown>>,
    defs: ChannelImplDefinition[],
    hub: WsHub,
    opts: typeof DEFAULTS,
    env: RuntimeEnv,
  ) {
    this.#args = args;
    this.#socket = args.socket;
    this.#defs = defs;
    this.#hub = hub;
    this.#opts = opts;
    this.#env = env;
  }

  // ── Scheduling ──────────────────────────────────────────────────────

  enqueue(raw: string | Uint8Array): void {
    if (this.#pending >= this.#opts.maxPendingFrames) {
      this.#socket.close(WsCloseCode.TryAgainLater, "Too many pending frames");
      return;
    }
    this.#schedule(() => this.#process(raw));
  }

  #schedule(task: () => Promise<void> | void): void {
    this.#pending++;
    this.#chain = this.#chain
      .then(task)
      .catch((err) =>
        this.#env.logger.error("[fishenv.ws] channel task failed:", err),
      )
      .finally(() => {
        this.#pending--;
      });
  }

  // ── Frame processing ────────────────────────────────────────────────

  async #process(raw: string | Uint8Array): Promise<void> {
    if (this.#socket.closed) return;

    let frame: ClientFrame;
    try {
      if (typeof raw !== "string")
        throw new FrameError("Binary frames are not supported");
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        throw new FrameError("Invalid JSON");
      }
      frame = parseClientFrame(value);
    } catch (err) {
      if (!(err instanceof FrameError)) throw err;
      this.#fail(
        err.ref,
        err.ch,
        new ChannelError(400, "bad_request", err.message),
      );
      return;
    }

    try {
      switch (frame.t) {
        case "join":
          return await this.#join(frame);
        case "event":
          return await this.#event(frame);
        case "leave":
          return await this.#leave(frame);
        case "presence_update":
          return await this.#presenceUpdate(frame);
      }
    } catch (err) {
      this.#fail(frame.ref, frame.ch, err);
    }
  }

  async #join(frame: Extract<ClientFrame, { t: "join" }>): Promise<void> {
    if (this.#joined.has(frame.ch)) {
      throw new ChannelError(409, "already_joined", "Channel already joined");
    }
    const match = this.#match(frame.ch);
    if (match == null)
      throw new ChannelError(404, "unknown_channel", "Unknown channel");
    if (this.#joined.size >= this.#opts.maxChannelsPerSocket) {
      throw new ChannelError(
        429,
        "too_many_channels",
        "Too many channels joined",
      );
    }

    const { def, raw } = match;
    const contract = def.contract._definition;
    const path = validatePathParams(raw, contract.paramSchemas);
    const data = parsePayload(contract.join.payload, frame.d);

    const context = this.#context(def, frame.ch);
    const args = { ...this.#base(path), data, channel: context };
    const reply = def.join ? await def.join(args) : undefined;
    checkOutbound(
      contract.join.reply,
      reply,
      this.#env.development,
      `join reply of "${frame.ch}"`,
    );

    // Resolve presence before committing, so a failing tracker aborts the join.
    const presence = contract.presence;
    const tracked =
      presence != null && def.presence != null
        ? ((await def.presence(args)) as
            | { key: string; meta: unknown }
            | null
            | undefined)
        : null;
    if (tracked != null) {
      checkOutbound(
        presence?.meta,
        tracked.meta,
        this.#env.development,
        `presence meta of "${frame.ch}"`,
      );
    }

    if (this.#socket.closed) return;
    const room = channelRoom(frame.ch);
    this.#hub.join(this.#socket, room);
    this.#hub._onLeave(this.#socket, room, (reason) =>
      this.#schedule(() => this.#serverLeave(frame.ch, "kicked", reason)),
    );
    this.#joined.set(frame.ch, { impl: def, name: frame.ch, path, context });
    this.#reply(frame.ref, reply);

    if (presence != null) {
      const registry = presenceFor(this.#hub);
      if (tracked != null) {
        registry.track(room, this.#socket, tracked.key, tracked.meta);
      }
      this.#send(
        encodeFrame({
          t: "presence_state",
          ch: frame.ch,
          d: registry.list(room),
        }),
      );
    }
  }

  async #presenceUpdate(
    frame: Extract<ClientFrame, { t: "presence_update" }>,
  ): Promise<void> {
    const joined = this.#joined.get(frame.ch);
    if (joined == null)
      throw new ChannelError(403, "not_joined", "Channel not joined");
    const presence = joined.impl.contract._definition.presence;
    if (presence == null || !presence.clientUpdates) {
      throw new ChannelError(
        403,
        "forbidden",
        "Presence updates are not allowed on this channel",
      );
    }
    const room = channelRoom(frame.ch);
    const registry = presenceFor(this.#hub);
    if (registry.metaOf(room, this.#socket) === undefined) {
      throw new ChannelError(
        409,
        "not_tracked",
        "This socket is not tracked in presence",
        false,
      );
    }
    const meta = parsePayload(presence.meta, frame.d);
    let bucket = this.#presenceBuckets.get(frame.ch);
    if (bucket == null) {
      bucket = new TokenBucket(1, PRESENCE_UPDATE_INTERVAL_MS);
      this.#presenceBuckets.set(frame.ch, bucket);
    }
    if (!bucket.take()) {
      throw new ChannelError(
        429,
        "rate_limited",
        "Presence updates are rate limited",
        false,
      );
    }
    registry.update(room, this.#socket, meta);
    this.#reply(frame.ref, undefined);
  }

  async #event(frame: Extract<ClientFrame, { t: "event" }>): Promise<void> {
    const joined = this.#joined.get(frame.ch);
    if (joined == null)
      throw new ChannelError(403, "not_joined", "Channel not joined");

    const { impl } = joined;
    const declared = impl.contract._definition.clientEvents.get(frame.ev);
    const handler = impl.events.get(frame.ev);

    let result: unknown;
    if (declared != null && handler != null) {
      const data = parsePayload(declared.payload, frame.d);
      result = await handler({
        ...this.#base(joined.path),
        data,
        channel: joined.context,
      });
      checkOutbound(
        declared.reply,
        result,
        this.#env.development,
        `reply to "${frame.ev}" on "${frame.ch}"`,
      );
    } else if (impl.any != null) {
      result = await impl.any({
        ...this.#base(joined.path),
        event: frame.ev,
        data: frame.d,
        channel: joined.context,
      });
    } else {
      throw new ChannelError(404, "unknown_event", "Unknown event");
    }
    this.#reply(frame.ref, result);
  }

  async #leave(frame: Extract<ClientFrame, { t: "leave" }>): Promise<void> {
    const joined = this.#joined.get(frame.ch);
    if (joined == null)
      throw new ChannelError(403, "not_joined", "Channel not joined");
    this.#forget(joined);
    await this.#runLeave(joined, "client");
    this.#reply(frame.ref, undefined);
  }

  /** Kick or `channel.leave()`: tell the client, then run the leave handler. */
  async #serverLeave(
    name: string,
    reason: LeaveReason,
    message: string,
  ): Promise<void> {
    const joined = this.#joined.get(name);
    if (joined == null) return;
    this.#forget(joined);
    this.#send(encodeFrame({ t: "close", ch: name, reason: message }));
    await this.#runLeave(joined, reason);
  }

  /** Socket closed: run every leave handler once. Hub rooms clean up themselves. */
  disconnect(): void {
    if (this.#disconnected) return;
    this.#disconnected = true;
    this.#schedule(async () => {
      for (const joined of [...this.#joined.values()]) {
        this.#joined.delete(joined.name);
        await this.#runLeave(joined, "disconnect");
      }
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  #forget(joined: Joined): void {
    this.#joined.delete(joined.name);
    this.#presenceBuckets.delete(joined.name);
    const room = channelRoom(joined.name);
    this.#hub.leave(this.#socket, room);
    if (joined.impl.contract._definition.presence != null) {
      presenceFor(this.#hub).untrack(room, this.#socket);
    }
  }

  async #runLeave(joined: Joined, reason: LeaveReason): Promise<void> {
    if (joined.impl.leave == null) return;
    try {
      await joined.impl.leave({ ...this.#base(joined.path), reason });
    } catch (err) {
      this.#env.logger.error(
        `[fishenv.ws] leave handler of "${joined.name}" failed:`,
        err,
      );
    }
  }

  #match(
    name: string,
  ): { def: ChannelImplDefinition; raw: Record<string, string> } | null {
    for (const def of this.#defs) {
      const match = def.pattern.exec(`/${name}`);
      if (match == null) continue;
      const raw: Record<string, string> = {};
      def.paramNames.forEach((param, i) => {
        const value = match[i + 1];
        if (value !== undefined) raw[param] = value;
      });
      return { def, raw };
    }
    return null;
  }

  #base(path: Record<string, unknown>) {
    const { ctx, req, container } = this.#args;
    return { ctx, path, req, container, socket: this.#socket };
  }

  #context(def: ChannelImplDefinition, name: string): ChannelContext<unknown> {
    const serverEvents = def.contract._definition.serverEvents;
    const check = (event: string, payload: unknown) => {
      if (!this.#env.development || serverEvents.size === 0) return;
      const schema = serverEvents.get(event);
      if (schema == null) {
        throw new Error(
          `"${event}" is not a server event of channel "${def.contract.name}"`,
        );
      }
      checkOutbound(schema, payload, true, `serverEvent "${event}"`);
    };
    const target = () => this.#hub.channel(name);
    const presenceDef = def.contract._definition.presence;
    const room = channelRoom(name);
    const presence =
      presenceDef == null
        ? undefined
        : {
            update: (meta: unknown) => {
              checkOutbound(
                presenceDef.meta,
                meta,
                this.#env.development,
                `presence meta of "${name}"`,
              );
              return presenceFor(this.#hub).update(room, this.#socket, meta);
            },
            list: () => presenceFor(this.#hub).list(room),
            has: (key: string) => presenceFor(this.#hub).has(room, key),
            keys: () => presenceFor(this.#hub).keys(room),
          };

    return {
      name,
      presence,
      broadcast: (event: string, payload: unknown) => {
        check(event, payload);
        return target().send(event, payload);
      },
      broadcastFrom: (event: string, payload: unknown) => {
        check(event, payload);
        return target().except(this.#socket).send(event, payload);
      },
      push: (event: string, payload: unknown) => {
        check(event, payload);
        return this.#socket.send(eventFrame(name, event, payload));
      },
      leave: (reason = "") => {
        this.#schedule(() => this.#serverLeave(name, "server", reason));
      },
    } as ChannelContext<unknown>;
  }

  #reply(ref: number | undefined, d: unknown): void {
    if (ref === undefined) return;
    this.#send(
      encodeFrame(
        d === undefined
          ? { t: "reply", ref, ok: true }
          : { t: "reply", ref, ok: true, d },
      ),
    );
  }

  #fail(ref: number | undefined, ch: string | undefined, err: unknown): void {
    const wire = this.#toWire(err);
    if (ref !== undefined) {
      this.#send(encodeFrame({ t: "reply", ref, ok: false, err: wire }));
    } else {
      this.#send(
        encodeFrame(
          ch ? { t: "error", ch, err: wire } : { t: "error", err: wire },
        ),
      );
    }

    const violation =
      (err instanceof ChannelError && err.violation) ||
      err instanceof ValidationError;
    if (violation && ++this.#violations >= this.#opts.maxViolations) {
      this.#socket.close(
        WsCloseCode.PolicyViolation,
        "Too many protocol violations",
      );
    }
  }

  #toWire(err: unknown): WireError {
    if (err instanceof WsCloseError) {
      // A handler asked for the whole socket to go away.
      this.#socket.close(err.code, err.message);
    }
    if (err instanceof HttpError) return err.toJSON(this.#env.development);
    this.#env.logger.error("[fishenv.ws] channel handler failed:", err);
    const wire: WireError = {
      status: 500,
      code: "internal",
      message: "Internal Server Error",
    };
    if (this.#env.development && err instanceof Error) {
      wire.message = err.message;
      wire.stack = err.stack;
    }
    return wire;
  }

  #send(frame: string): void {
    this.#socket.send(frame);
  }
}

/** Client presence updates allowed per channel per socket: one per second. */
const PRESENCE_UPDATE_INTERVAL_MS = 1_000;

const CHANNEL_ROOM_PREFIX = channelRoom("");
const fanOutInstalled = new WeakSet<WsHub>();
const LOCAL_ONLY: RoomFilter = {
  exceptIds: new Set(),
  exceptKeys: new Set(),
  onlyKeys: null,
};

/**
 * The hub's presence registry, with presence diffs of channel topics fanned
 * out to the channel's *local* members — every node derives the same diffs
 * from replicated state, so nothing is re-published over the transport.
 */
function presenceFor(hub: WsHub): PresenceRegistry {
  const registry = hub._presenceRegistry();
  if (!fanOutInstalled.has(hub)) {
    fanOutInstalled.add(hub);
    registry.onDiff((topic, diff) => {
      if (!topic.startsWith(CHANNEL_ROOM_PREFIX)) return;
      const ch = topic.slice(CHANNEL_ROOM_PREFIX.length);
      hub._sendRoom(
        topic,
        encodeFrame({
          t: "presence_diff",
          ch,
          joins: diff.joins,
          leaves: diff.leaves,
        }),
        LOCAL_ONLY,
        false,
      );
    });
  }
  return registry;
}

/** Validate a client payload; no schema means the payload is ignored. */
function parsePayload(schema: AnySchema | undefined, value: unknown): unknown {
  if (schema == null) return undefined;
  const result = v.safeParse(schema, value);
  if (!result.success) throw new ValidationError("body", result.issues);
  return result.output;
}
