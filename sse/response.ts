/** Turning a request into a streaming `text/event-stream` response. */

import { DEFAULT_HIGH_WATER_MARK, SseConnection } from "./connection.ts";
import type { SseCleanupFn, SseConnectionOptions } from "./types.ts";

export type SseOpenFn = (
  sse: SseConnection,
) => void | SseCleanupFn | Promise<void | SseCleanupFn>;

/**
 * `onOpen` runs after the response has been handed to the client, so anything
 * it throws can no longer change the status code — it is logged and the stream
 * is closed.
 */
export function createSseResponse(
  req: Request,
  options: SseConnectionOptions,
  onOpen: SseOpenFn,
): Response {
  const highWaterMark = options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
  let connection: SseConnection | undefined;

  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const sse = new SseConnection(controller, req, options);
        connection = sse;

        if (options.retryMs != null) sse.retry(options.retryMs);

        if (options.keepaliveMs != null && options.keepaliveMs > 0) {
          const timer = setInterval(
            () => sse.comment("ka"),
            options.keepaliveMs,
          );
          sse.onClose(() => clearInterval(timer));
        }

        // Not awaited: a handler that never resolves must not block the stream.
        void (async () => {
          try {
            const cleanup = await onOpen(sse);
            if (typeof cleanup === "function") sse.onClose(cleanup);
          } catch (err) {
            console.error(
              "[fishenv.sse] handler error after stream start:",
              err,
            );
            sse.close();
          }
        })();
      },
      cancel() {
        // Sole disconnect signal: `req.signal` also fires on *successful*
        // delivery under Deno.serve's legacy abort semantics, which would tear
        // down healthy streams.
        connection?.close();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark }),
  );

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      // `no-transform` stops proxies (and Deno's own compression) from buffering.
      "cache-control": "no-cache, no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
