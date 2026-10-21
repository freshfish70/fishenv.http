/**
 * Turns a route's `handle(fn)` into the per-socket `SocketHandlers` that core
 * dispatches to. One lifecycle object is created per accepted handshake.
 */

import {
  HttpError,
  type Logger,
  type SocketHandlers,
  type UpgradedSocket,
} from "../core/index.ts";
import { runCallback, WsConnection } from "./connection.ts";
import { TokenBucket } from "./limits.ts";
import { WsMessage } from "./message.ts";
import {
  closeFrameFor,
  DEFAULT_MAX_QUEUED_MESSAGES,
  type WsCleanupFn,
  WsCloseCode,
  WsCloseError,
  type WsConnectionOptions,
} from "./types.ts";

export type WsSetupFn = (
  socket: WsConnection,
) => void | WsCleanupFn | Promise<void | WsCleanupFn>;

export interface LifecycleOptions extends WsConnectionOptions {
  logger?: Pick<Logger, "error">;
  /** Called after the socket opened and before setup runs; throw to reject. */
  onOpen?: (socket: WsConnection) => void;
}

/**
 * - Messages arriving while an async setup is still running are buffered
 *   (bounded) and replayed in order once it settles — Bun does not hold
 *   `message` back while `open` awaits.
 * - Size and rate limits are enforced before anything reaches user code.
 * - Any throw/rejection closes the socket via {@link closeFrameFor}.
 */
export function createLifecycle(
  req: Request,
  protocol: string | null,
  setup: WsSetupFn,
  options: LifecycleOptions = {},
): SocketHandlers {
  const logger = options.logger ?? console;
  const maxQueued = options.maxQueuedMessages ?? DEFAULT_MAX_QUEUED_MESSAGES;
  const limiter = options.rateLimit
    ? new TokenBucket(options.rateLimit.messages, options.rateLimit.perMs)
    : null;

  let socket: WsConnection | undefined;
  let ready = false;
  const queue: WsMessage[] = [];

  const fail = (err: unknown) => {
    if (!(err instanceof WsCloseError || err instanceof HttpError)) {
      logger.error("[fishenv.ws] handler failed:", err);
    }
    const frame = closeFrameFor(err, options.development);
    socket?.close(frame.code, frame.reason);
  };

  const flush = () => {
    ready = true;
    while (socket != null && !socket.closed && queue.length > 0) {
      socket._deliver(queue.shift()!);
    }
    queue.length = 0;
  };

  return {
    open(ws: UpgradedSocket) {
      const conn = new WsConnection(ws, req, protocol, fail);
      socket = conn;

      let result: ReturnType<WsSetupFn>;
      try {
        options.onOpen?.(conn);
        result = setup(conn);
      } catch (err) {
        fail(err);
        return;
      }

      const settle = (cleanup: void | WsCleanupFn) => {
        if (typeof cleanup === "function") conn.onClose(cleanup);
        flush();
      };
      if (result instanceof Promise) result.then(settle, fail);
      else settle(result);
    },

    message(_ws, raw) {
      if (socket == null || socket.closed) return;
      const message = new WsMessage(raw);

      if (
        options.maxMessageSize != null &&
        message.size > options.maxMessageSize
      ) {
        socket.close(WsCloseCode.MessageTooBig, "Message too big");
        return;
      }

      if (limiter != null && !limiter.take()) {
        if (options.rateLimit?.onExceed === "drop") return;
        socket.close(WsCloseCode.PolicyViolation, "Rate limit exceeded");
        return;
      }

      if (!ready) {
        if (queue.length >= maxQueued) {
          socket.close(WsCloseCode.PolicyViolation, "Too many queued messages");
          return;
        }
        queue.push(message);
        return;
      }

      socket._deliver(message);
    },

    close(_ws, code, reason) {
      queue.length = 0;
      socket?._closed(code, reason);
    },

    drain() {
      if (socket != null) runCallback(() => socket?._drained(), fail);
    },
  };
}
