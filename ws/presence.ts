/**
 * Presence — *who* is in a topic (a channel, or any app-defined topic like
 * `"online-users"`), keyed by identity rather than by socket, replicated
 * across nodes.
 *
 * Model: an entry is `(key, ref, meta)` — `key` is the identity (user id),
 * `ref` the connection id, `meta` app data. Three tabs = one key, three refs;
 * closing one tab is not a "leave" of the user.
 *
 * Replication is single-writer: every entry is owned by the node holding its
 * socket and only that node writes it, so state is conflict-free without a
 * merge CRDT. Each node stamps its messages with a per-node clock; a gap or
 * an unknown node triggers a full `sync` from the owner. Nodes heartbeat;
 * a silent node is declared dead and its entries are dropped.
 */

import type { WsConnection } from "./connection.ts";
import type { WsHub } from "./hub.ts";

export interface PresenceEntry<M = unknown> {
  /** Connection id. */
  ref: string;
  meta: M;
}

/** Entries grouped by key — the wire format of state and diffs. */
export type PresenceState<M = unknown> = Record<string, PresenceEntry<M>[]>;

export interface PresenceDiff<M = unknown> {
  joins: PresenceState<M>;
  leaves: PresenceState<M>;
}

export interface PresenceOptions {
  /** Client-facing diff coalescing window. Default 50 ms. */
  batchMs?: number;
  /** Heartbeat interval on a transport. Default 5 s. */
  heartbeatMs?: number;
  /** A node silent for longer is considered dead. Default 15 s. */
  peerTimeoutMs?: number;
  /** Max entries per topic on this node (protects memory). Default 10 000. */
  maxEntriesPerTopic?: number;
  /** Injectable clock/timers for tests. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

interface Stored {
  key: string;
  meta: unknown;
}

/** topic → ref → entry */
type TopicMap = Map<string, Map<string, Stored>>;

type PresenceMessage =
  | {
      op: "diff";
      node: string;
      clock: number;
      topic: string;
      joins: WireEntries;
      leaves: string[];
    }
  | { op: "heartbeat"; node: string; clock: number }
  | { op: "sync_request"; node: string; target: string | "*" }
  | {
      op: "sync";
      node: string;
      clock: number;
      to: string;
      topics: Record<string, WireEntries>;
    };

/** ref → { key, meta } */
type WireEntries = Record<string, Stored>;

interface Peer {
  clock: number;
  lastSeen: number;
  /** Waiting for a full sync; diffs are ignored until it arrives. */
  syncing: boolean;
  topics: TopicMap;
}

type DiffListener = (topic: string, diff: PresenceDiff) => void;

export class PresenceLimitError extends Error {
  constructor(topic: string) {
    super(`Presence topic "${topic}" is full`);
    this.name = "PresenceLimitError";
  }
}

/**
 * Per-hub presence state. Get it via `hub.presence(topic)` — you rarely
 * construct this directly.
 */
export class PresenceRegistry {
  readonly #hub: WsHub;
  readonly #opts: Required<
    Pick<
      PresenceOptions,
      "batchMs" | "heartbeatMs" | "peerTimeoutMs" | "maxEntriesPerTopic"
    >
  >;
  readonly #now: () => number;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  readonly #setInterval: (fn: () => void, ms: number) => unknown;
  readonly #clearInterval: (handle: unknown) => void;

  readonly #local: TopicMap = new Map();
  readonly #sockets = new Map<string, WsConnection>();
  readonly #peers = new Map<string, Peer>();
  readonly #listeners = new Set<DiffListener>();
  readonly #pending = new Map<
    string,
    { joins: Map<string, Stored>; leaves: Map<string, Stored> }
  >();
  #flushTimer: unknown;
  #clock = 0;
  #intervals: unknown[] = [];
  #replicated: boolean;

  constructor(hub: WsHub, replicated: boolean, options: PresenceOptions = {}) {
    this.#hub = hub;
    this.#replicated = replicated;
    this.#opts = {
      batchMs: options.batchMs ?? 50,
      heartbeatMs: options.heartbeatMs ?? 5_000,
      peerTimeoutMs: options.peerTimeoutMs ?? 15_000,
      maxEntriesPerTopic: options.maxEntriesPerTopic ?? 10_000,
    };
    this.#now = options.now ?? Date.now;
    this.#setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as never));
    this.#setInterval =
      options.setInterval ??
      ((fn, ms) => {
        const handle = setInterval(fn, ms);
        (handle as { unref?: () => void }).unref?.();
        return handle;
      });
    this.#clearInterval =
      options.clearInterval ?? ((h) => clearInterval(h as never));

    if (replicated) {
      hub._registerExtension("presence", (body) =>
        this.#onRemote(body as PresenceMessage),
      );
      this.#intervals.push(
        this.#setInterval(() => this.#heartbeat(), this.#opts.heartbeatMs),
        this.#setInterval(() => this.#sweep(), this.#opts.heartbeatMs),
      );
      // Ask everyone for their current entries.
      this.#publish({
        op: "sync_request",
        node: this.#hub.nodeId,
        target: "*",
      });
    }
  }

  // ── Local writes ────────────────────────────────────────────────────

  /**
   * Track `socket` in `topic` under `key`. Re-tracking replaces the meta.
   * Untracked automatically when the socket closes.
   */
  track(topic: string, socket: WsConnection, key: string, meta: unknown): void {
    if (socket.closed) return;
    let entries = this.#local.get(topic);
    if (entries == null) {
      entries = new Map();
      this.#local.set(topic, entries);
    }
    const previous = entries.get(socket.id);
    if (previous == null && entries.size >= this.#opts.maxEntriesPerTopic) {
      throw new PresenceLimitError(topic);
    }
    const stored = { key, meta };
    entries.set(socket.id, stored);

    if (!this.#sockets.has(socket.id)) {
      this.#sockets.set(socket.id, socket);
      socket.onClose(() => this.#untrackSocket(socket));
    }

    const leaves = previous ? { [socket.id]: previous } : {};
    this.#queue(topic, { [socket.id]: stored }, leaves);
    this.#publishDiff(
      topic,
      { [socket.id]: stored },
      previous ? [socket.id] : [],
    );
  }

  /** Replace the meta of an already tracked socket. No-op if untracked. */
  update(topic: string, socket: WsConnection, meta: unknown): boolean {
    const current = this.#local.get(topic)?.get(socket.id);
    if (current == null) return false;
    this.track(topic, socket, current.key, meta);
    return true;
  }

  untrack(topic: string, socket: WsConnection): void {
    const entries = this.#local.get(topic);
    const previous = entries?.get(socket.id);
    if (entries == null || previous == null) return;
    entries.delete(socket.id);
    if (entries.size === 0) this.#local.delete(topic);
    this.#queue(topic, {}, { [socket.id]: previous });
    this.#publishDiff(topic, {}, [socket.id]);
  }

  // ── Reads (cluster-wide) ────────────────────────────────────────────

  list(topic: string): PresenceState {
    const state: PresenceState = {};
    const add = (entries: Map<string, Stored> | undefined) => {
      for (const [ref, { key, meta }] of entries ?? []) {
        addEntry(state, key, ref, meta);
      }
    };
    add(this.#local.get(topic));
    for (const peer of this.#peers.values()) add(peer.topics.get(topic));
    return state;
  }

  has(topic: string, key: string): boolean {
    return this.list(topic)[key] != null;
  }

  keys(topic: string): string[] {
    return Object.keys(this.list(topic));
  }

  /** Tracked meta of a local socket. */
  metaOf(topic: string, socket: WsConnection): unknown {
    return this.#local.get(topic)?.get(socket.id)?.meta;
  }

  /** Topics with at least one entry anywhere. */
  topics(): string[] {
    const all = new Set(this.#local.keys());
    for (const peer of this.#peers.values()) {
      for (const topic of peer.topics.keys()) all.add(topic);
    }
    return [...all];
  }

  /** Coalesced diffs for every topic (local and remote changes). */
  onDiff(fn: DiffListener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Stop timers and drop remote state (e.g. on shutdown). */
  close(): void {
    for (const handle of this.#intervals) this.#clearInterval(handle);
    this.#intervals = [];
    if (this.#flushTimer != null) this.#clearTimer(this.#flushTimer);
    this.#flushTimer = undefined;
    this.#replicated = false;
  }

  // ── Batching ────────────────────────────────────────────────────────

  #queue(topic: string, joins: WireEntries, leaves: WireEntries): void {
    let pending = this.#pending.get(topic);
    if (pending == null) {
      pending = { joins: new Map(), leaves: new Map() };
      this.#pending.set(topic, pending);
    }
    for (const [ref, entry] of Object.entries(leaves)) {
      if (pending.joins.has(ref)) {
        // Joined within this window, so clients never saw that version. If
        // they saw an older one, its leave is already queued.
        pending.joins.delete(ref);
        continue;
      }
      if (!pending.leaves.has(ref)) pending.leaves.set(ref, entry);
    }
    for (const [ref, entry] of Object.entries(joins))
      pending.joins.set(ref, entry);

    this.#flushTimer ??= this.#setTimer(() => this.flush(), this.#opts.batchMs);
  }

  /** Emit pending diffs now. Called automatically after `batchMs`. */
  flush(): void {
    if (this.#flushTimer != null) this.#clearTimer(this.#flushTimer);
    this.#flushTimer = undefined;
    const pending = [...this.#pending];
    this.#pending.clear();
    for (const [topic, { joins, leaves }] of pending) {
      if (joins.size === 0 && leaves.size === 0) continue;
      const diff: PresenceDiff = { joins: group(joins), leaves: group(leaves) };
      for (const fn of [...this.#listeners]) {
        try {
          fn(topic, diff);
        } catch (err) {
          console.error("[fishenv.ws] presence listener failed:", err);
        }
      }
    }
  }

  // ── Replication ─────────────────────────────────────────────────────

  #publish(message: PresenceMessage): void {
    if (this.#replicated) this.#hub._publishExtension("presence", message);
  }

  #tick(): number {
    return ++this.#clock;
  }

  #publishDiff(topic: string, joins: WireEntries, leaves: string[]): void {
    if (!this.#replicated) return;
    this.#publish({
      op: "diff",
      node: this.#hub.nodeId,
      clock: this.#tick(),
      topic,
      joins,
      leaves,
    });
  }

  #heartbeat(): void {
    this.#publish({
      op: "heartbeat",
      node: this.#hub.nodeId,
      clock: this.#tick(),
    });
  }

  /** Drop peers that stopped heart-beating (crashed or partitioned nodes). */
  #sweep(): void {
    const deadline = this.#now() - this.#opts.peerTimeoutMs;
    for (const [node, peer] of [...this.#peers]) {
      if (peer.lastSeen >= deadline) continue;
      this.#peers.delete(node);
      for (const [topic, entries] of peer.topics) {
        this.#queue(topic, {}, Object.fromEntries(entries));
      }
    }
  }

  #onRemote(message: PresenceMessage): void {
    if (message == null || typeof message !== "object") return;
    if (message.node === this.#hub.nodeId) return;

    if (message.op === "sync_request") {
      if (message.target === "*" || message.target === this.#hub.nodeId) {
        this.#sendSync(message.node);
      }
      return;
    }

    let peer = this.#peers.get(message.node);
    const isNew = peer == null;
    if (peer == null) {
      peer = {
        clock: 0,
        lastSeen: this.#now(),
        syncing: false,
        topics: new Map(),
      };
      this.#peers.set(message.node, peer);
    }
    peer.lastSeen = this.#now();

    if (message.op === "sync") {
      if (message.to === this.#hub.nodeId) this.#applySync(peer, message);
      else if (!peer.syncing)
        this.#advance(message.node, peer, message.clock, isNew);
      return;
    }

    if (peer.syncing) return; // the snapshot will contain it
    if (!this.#advance(message.node, peer, message.clock, isNew)) return;

    if (message.op === "diff") this.#applyDiff(peer, message);
  }

  /** Check clock continuity; on a gap request a full sync. */
  #advance(node: string, peer: Peer, clock: number, isNew: boolean): boolean {
    if (clock === peer.clock + 1 || (isNew && clock === 1)) {
      peer.clock = clock;
      return true;
    }
    if (clock <= peer.clock) return false; // duplicate / reordered — ignore
    peer.syncing = true;
    this.#publish({ op: "sync_request", node: this.#hub.nodeId, target: node });
    return false;
  }

  #applyDiff(
    peer: Peer,
    message: Extract<PresenceMessage, { op: "diff" }>,
  ): void {
    let entries = peer.topics.get(message.topic);
    if (entries == null) {
      entries = new Map();
      peer.topics.set(message.topic, entries);
    }
    const leaves: WireEntries = {};
    for (const ref of message.leaves) {
      const previous = entries.get(ref);
      if (previous == null) continue;
      entries.delete(ref);
      leaves[ref] = previous;
    }
    for (const [ref, entry] of Object.entries(message.joins))
      entries.set(ref, entry);
    if (entries.size === 0) peer.topics.delete(message.topic);
    this.#queue(message.topic, message.joins, leaves);
  }

  #sendSync(to: string): void {
    const topics: Record<string, WireEntries> = {};
    for (const [topic, entries] of this.#local)
      topics[topic] = Object.fromEntries(entries);
    this.#publish({
      op: "sync",
      node: this.#hub.nodeId,
      clock: this.#tick(),
      to,
      topics,
    });
  }

  /** Replace a peer's state with its snapshot and emit the difference. */
  #applySync(
    peer: Peer,
    message: Extract<PresenceMessage, { op: "sync" }>,
  ): void {
    const previous = peer.topics;
    const next: TopicMap = new Map();
    for (const [topic, entries] of Object.entries(message.topics)) {
      next.set(topic, new Map(Object.entries(entries)));
    }
    const allTopics = new Set([...previous.keys(), ...next.keys()]);
    for (const topic of allTopics) {
      const before = previous.get(topic) ?? new Map<string, Stored>();
      const after = next.get(topic) ?? new Map<string, Stored>();
      const joins: WireEntries = {};
      const leaves: WireEntries = {};
      for (const [ref, entry] of before) {
        const now = after.get(ref);
        if (now == null || !sameEntry(now, entry)) leaves[ref] = entry;
      }
      for (const [ref, entry] of after) {
        const was = before.get(ref);
        if (was == null || !sameEntry(was, entry)) joins[ref] = entry;
      }
      this.#queue(topic, joins, leaves);
    }
    peer.topics = next;
    peer.clock = message.clock;
    peer.syncing = false;
  }

  #untrackSocket(socket: WsConnection): void {
    this.#sockets.delete(socket.id);
    for (const topic of [...this.#local.keys()]) this.untrack(topic, socket);
  }
}

function addEntry(
  state: PresenceState,
  key: string,
  ref: string,
  meta: unknown,
): void {
  const list = state[key];
  if (list == null) state[key] = [{ ref, meta }];
  else list.push({ ref, meta });
}

function sameEntry(a: Stored, b: Stored): boolean {
  return a.key === b.key && JSON.stringify(a.meta) === JSON.stringify(b.meta);
}

function group(entries: Map<string, Stored>): PresenceState {
  const state: PresenceState = {};
  for (const [ref, { key, meta }] of entries) addEntry(state, key, ref, meta);
  return state;
}

/** A read/write view of one topic, from `hub.presence(topic)`. */
export class PresenceTopic<M = unknown> {
  readonly topic: string;
  readonly #registry: PresenceRegistry;

  /** @internal */
  constructor(registry: PresenceRegistry, topic: string) {
    this.#registry = registry;
    this.topic = topic;
  }

  track(socket: WsConnection, key: string, meta: M): void {
    this.#registry.track(this.topic, socket, key, meta);
  }

  update(socket: WsConnection, meta: M): boolean {
    return this.#registry.update(this.topic, socket, meta);
  }

  untrack(socket: WsConnection): void {
    this.#registry.untrack(this.topic, socket);
  }

  /** Cluster-wide: `{ [key]: { ref, meta }[] }`. */
  list(): PresenceState<M> {
    return this.#registry.list(this.topic) as PresenceState<M>;
  }

  has(key: string): boolean {
    return this.#registry.has(this.topic, key);
  }

  keys(): string[] {
    return this.#registry.keys(this.topic);
  }

  /** Number of distinct keys (users), cluster-wide. */
  count(): number {
    return this.keys().length;
  }

  /** Coalesced diffs of this topic. */
  onDiff(fn: (diff: PresenceDiff<M>) => void): () => void {
    return this.#registry.onDiff((topic, diff) => {
      if (topic === this.topic) fn(diff as PresenceDiff<M>);
    });
  }
}
