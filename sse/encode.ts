/** SSE wire format — turning values into `text/event-stream` frames. */

import type { SseEventOptions } from "./types.ts";

/** Field values are attacker-reachable; CR/LF/NUL would forge extra frames. */
export function sanitizeField(value: string): string {
  return value.replace(/[\r\n\0]/g, "");
}

/** Serialize a value into a complete SSE frame (including the terminating blank line). */
export function encodeSseEvent(data: unknown, opts?: SseEventOptions): string {
  let frame = "";
  if (opts?.id != null) frame += `id: ${sanitizeField(opts.id)}\n`;
  if (opts?.event != null) frame += `event: ${sanitizeField(opts.event)}\n`;
  if (opts?.retry != null) frame += `retry: ${Math.trunc(opts.retry)}\n`;

  const text = typeof data === "string" ? data : (JSON.stringify(data) ?? "");
  for (const line of text.split(/\r\n|\r|\n/)) frame += `data: ${line}\n`;

  return `${frame}\n`;
}

/** A standalone `retry:` frame, sent without any accompanying data. */
export function encodeSseRetry(ms: number): string {
  return `retry: ${Math.trunc(ms)}\n\n`;
}

/** A comment frame — invisible to `EventSource`, used as a heartbeat. */
export function encodeSseComment(text: string): string {
  return `: ${sanitizeField(text)}\n\n`;
}
