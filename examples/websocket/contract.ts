/**
 * The WebSocket contract — pure data, shared by the server and any client.
 * Depends on `@fishenv/http/contract` and valibot; the error classes are
 * referenced for documentation and client-side error typing only.
 */

import { ForbiddenError } from "@fishenv/http";
import { c } from "@fishenv/http/contract";
import * as v from "valibot";

export const Message = v.object({
  id: v.string(),
  from: v.string(),
  text: v.string(),
});

export const room = c
  .channel("rooms/:roomId")
  .param("roomId", v.pipe(v.string(), v.regex(/^[a-z0-9-]{1,32}$/)))
  .join(
    v.object({ lastSeen: v.optional(v.number()) }),
    v.object({ history: v.array(Message) }),
    [ForbiddenError],
  )
  .clientEvent(
    "message",
    v.object({ text: v.pipe(v.string(), v.minLength(1), v.maxLength(500)) }),
    v.object({ id: v.string() }),
  )
  .clientEvent("typing", v.object({}))
  .serverEvent("message", Message)
  .serverEvent("typing", v.object({ userId: v.string() }))
  .presence(v.object({ status: v.picklist(["online", "away"]) }), {
    clientUpdates: true,
  });

export const notifications = c
  .channel("users/:userId/notifications")
  .join()
  .serverEvent("notification", v.object({ title: v.string() }));

export const chatSocket = c.ws("/chat").channels(room, notifications);
