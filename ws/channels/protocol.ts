/**
 * Wire protocol `fishenv.channels.v1` — JSON text frames.
 *
 * Client → server:
 *   { t: "join",  ref?, ch, d? }
 *   { t: "event", ref?, ch, ev, d? }
 *   { t: "leave", ref?, ch }
 *   { t: "presence_update", ref?, ch, d }
 *
 * Server → client:
 *   { t: "reply", ref, ok: true, d? } | { t: "reply", ref, ok: false, err }
 *   { t: "event", ch, ev, d }            — `seq` is reserved for replay
 *   { t: "close", ch, reason }           — server-initiated leave
 *   { t: "error", ch?, err }             — failure of a frame without `ref`
 *   { t: "presence_state", ch, d }
 *   { t: "presence_diff", ch, joins, leaves }
 *
 * Parsing reads only known keys and never merges client objects into
 * server state, so `__proto__` & co. are inert.
 */

import type { HttpErrorJSON } from "../../core/index.ts";

export { CHANNELS_PROTOCOL } from "../../contract/index.ts";

export const MAX_CHANNEL_NAME_LENGTH = 256;
export const MAX_EVENT_NAME_LENGTH = 128;
export const MAX_REF = 2 ** 31 - 1;

export type ClientFrame =
  | { t: "join"; ref?: number; ch: string; d?: unknown }
  | { t: "event"; ref?: number; ch: string; ev: string; d?: unknown }
  | { t: "leave"; ref?: number; ch: string }
  | { t: "presence_update"; ref?: number; ch: string; d?: unknown };

/** Public error payload; same shape as `HttpError.toJSON()` minus nothing. */
export type WireError = Pick<HttpErrorJSON, "status" | "code" | "message"> &
  Partial<Pick<HttpErrorJSON, "details" | "stack">>;

export type PresenceEntries = Record<string, { ref: string; meta: unknown }[]>;

export type ServerFrame =
  | { t: "reply"; ref: number; ok: true; d?: unknown }
  | { t: "reply"; ref: number; ok: false; err: WireError }
  | { t: "event"; ch: string; ev: string; d: unknown; seq?: number }
  | { t: "close"; ch: string; reason: string }
  | { t: "error"; ch?: string; err: WireError }
  | { t: "presence_state"; ch: string; d: PresenceEntries }
  | {
      t: "presence_diff";
      ch: string;
      joins: PresenceEntries;
      leaves: PresenceEntries;
    };

/** Why a frame was rejected; `ref` is recovered when possible for the reply. */
export class FrameError extends Error {
  readonly ref?: number;
  readonly ch?: string;
  constructor(message: string, ref?: number, ch?: string) {
    super(message);
    this.name = "FrameError";
    this.ref = ref;
    this.ch = ch;
  }
}

const TYPES = new Set(["join", "event", "leave", "presence_update"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRef(raw: Record<string, unknown>): number | undefined {
  const ref = raw.ref;
  if (ref === undefined) return undefined;
  if (
    typeof ref === "number" &&
    Number.isInteger(ref) &&
    ref >= 0 &&
    ref <= MAX_REF
  ) {
    return ref;
  }
  throw new FrameError("Invalid ref");
}

function readName(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value === "" || value.length > max) {
    return null;
  }
  // No control characters (incl. NUL) in names.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that's the point
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

/** Validate an already-JSON-parsed client frame. Throws {@link FrameError}. */
export function parseClientFrame(value: unknown): ClientFrame {
  if (!isRecord(value)) throw new FrameError("Frame must be an object");

  const ref = readRef(value);
  const t = value.t;
  if (typeof t !== "string" || !TYPES.has(t)) {
    throw new FrameError("Unknown frame type", ref);
  }

  const ch = readName(value.ch, MAX_CHANNEL_NAME_LENGTH);
  if (ch == null) throw new FrameError("Invalid channel name", ref);

  switch (t) {
    case "join":
      return { t, ref, ch, d: value.d };
    case "leave":
      return { t, ref, ch };
    case "presence_update":
      return { t, ref, ch, d: value.d };
    default: {
      const ev = readName(value.ev, MAX_EVENT_NAME_LENGTH);
      if (ev == null) throw new FrameError("Invalid event name", ref, ch);
      return { t: "event", ref, ch, ev, d: value.d };
    }
  }
}

export function encodeFrame(frame: ServerFrame): string {
  return JSON.stringify(frame);
}

export function eventFrame(ch: string, ev: string, d: unknown): string {
  return encodeFrame({ t: "event", ch, ev, d });
}
