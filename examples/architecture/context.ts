/**
 * App-wide middleware chain. Feature routers import only the `AppCtx` type
 * from here, and only main.ts imports `base` itself. Because this module never
 * imports a route module, there is no import cycle.
 */
import { r } from "@fishenv/http";
import type { CtxOf } from "@fishenv/http";

export const base = r({ prefix: "/api" })
  .use(() => ({ requestId: crypto.randomUUID() }));

export type AppCtx = CtxOf<typeof base>;
