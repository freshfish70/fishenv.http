import type {
  DIContainer,
  ErrorHandlerFn,
  InterceptorPair,
  MiddlewareFn,
  RouteDefinition,
} from "./types.ts";
import { defaultErrorHandler } from "./error.ts";
import { parseInput } from "./request.ts";

/**
 * Run the middleware pipeline, accumulating context via object spread.
 * Each middleware receives the accumulated ctx and returns new fields to merge.
 */
export async function runMiddlewarePipeline(
  req: Request,
  middlewares: MiddlewareFn<Record<string, unknown>, Record<string, unknown>>[],
  container: DIContainer,
): Promise<Record<string, unknown>> {
  let ctx: Record<string, unknown> = { req, container };
  for (const mw of middlewares) {
    const additions = await mw({ ...ctx, req });
    ctx = { ...ctx, ...additions };
  }
  return ctx;
}

/**
 * Run before interceptors, the handler, then after interceptors (in reverse).
 * Before and after share a mutable `state` object created per-request.
 */
export async function runInterceptors(
  interceptors: InterceptorPair<Record<string, unknown>>[],
  req: Request,
  ctx: Record<string, unknown>,
  handlerFn: () => Promise<Response>,
): Promise<Response> {
  const state: Record<string, unknown> = {};

  // Run all before interceptors
  for (const { before } of interceptors) {
    if (before) await before({ req, ctx, state });
  }

  // Run handler
  let response = await handlerFn();

  // Run all after interceptors in reverse order
  for (const { after } of [...interceptors].reverse()) {
    if (after) response = await after({ response, ctx, state });
  }

  return response;
}

/**
 * Coerce a handler's return value into a Response.
 * - If already a Response, pass through.
 * - If output schema is defined, serialize as JSON.
 * - Otherwise throw — handler contract violation.
 */
export function coerceToResponse(
  raw: unknown,
  def: RouteDefinition,
): Response {
  if (raw instanceof Response) return raw;
  if (def.outputSchema != null) return Response.json(raw);
  throw new TypeError(
    "Handler must return a Response when no output schema is defined",
  );
}

/**
 * Full request dispatch: middleware → input parsing → interceptors + handler → error chain.
 */
export async function dispatch(
  req: Request,
  definition: RouteDefinition,
  params: Record<string, string>,
  container: DIContainer,
  errorHandlers: ErrorHandlerFn[],
): Promise<Response> {
  try {
    // 1. Build context via middleware chain
    const ctx = await runMiddlewarePipeline(
      req,
      definition.middlewares,
      container,
    );

    // 2. Parse & validate input
    const input = await parseInput(req, definition, params);

    // 3. Run interceptors + handler
    const response = await runInterceptors(
      definition.interceptors,
      req,
      ctx,
      async () => {
        const raw = await definition.handler({
          req,
          ctx,
          container,
          path: input.path,
          body: input.body,
          headers: input.headers,
          query: input.query,
          cookies: input.cookies,
        });
        return coerceToResponse(raw, definition);
      },
    );

    return response;
  } catch (err) {
    for (const handler of errorHandlers) {
      const result = await handler(err, { req });
      if (result != null) return result;
    }
    // Built-in fallback always returns
    return defaultErrorHandler(err, { req });
  }
}
