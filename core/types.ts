/**
 * The "shape" types (schemas, input/output, params, HTTP method, route meta)
 * live in `@fishenv/http-contract` so that a `ContractBuilder` and a `RouteBuilder`
 * are built from exactly the same type definitions — no structural-typing
 * gap between `router.contract(endpoint).handle(...)` and
 * `router.post(path).input(...).output(...).handle(...)`.
 */
export type {
  AnySchema,
  BasePathParams,
  ExtractParams,
  HttpMethod,
  InferBody,
  InferCookies,
  InferHeaders,
  InferOutput,
  InferQuery,
  InputKind,
  InputOptions,
  MergeParam,
  RouteMeta,
  ValibotSchema,
} from "@fishenv/http-contract";

import type {
  AnySchema,
  HttpMethod,
  InferBody,
  InferCookies,
  InferHeaders,
  InferQuery,
  InputKind,
  InputOptions,
  RouteMeta,
} from "@fishenv/http-contract";

export interface ResolvedInput<K extends InputKind, O extends InputOptions<K>> {
  kind: K;
  options: O;
}

// ---------------------------------------------------------------------------
// Middleware Types
// ---------------------------------------------------------------------------

export type MiddlewareFn<In extends object, Out extends object> = (
  ctx: In & { req: Request },
) => Promise<Out> | Out;

export type MergeCtx<
  A extends Record<string, unknown>,
  B extends Record<string, unknown>,
> = A & B;

// ---------------------------------------------------------------------------
// Interceptor Types
// ---------------------------------------------------------------------------

export type InterceptorState = Record<string, unknown>;

export type BeforeInterceptorFn<Ctx extends Record<string, unknown>> = (args: {
  req: Request;
  ctx: Ctx;
  state: InterceptorState;
}) => Promise<void> | void;

export type AfterInterceptorFn<Ctx extends Record<string, unknown>> = (args: {
  response: Response;
  ctx: Ctx;
  state: InterceptorState;
}) => Promise<Response> | Response;

export interface InterceptorPair<Ctx extends Record<string, unknown>> {
  before?: BeforeInterceptorFn<Ctx>;
  after?: AfterInterceptorFn<Ctx>;
}

// ---------------------------------------------------------------------------
// Handler Types
// ---------------------------------------------------------------------------

export interface HandlerArgs<
  Ctx extends Record<string, unknown>,
  K extends InputKind,
  O extends InputOptions<K>,
  Params extends Record<string, unknown>,
> {
  req: Request;
  path: Params;
  ctx: Ctx;
  body: InferBody<K, O>;
  headers: InferHeaders<O>;
  query: InferQuery<O>;
  cookies: InferCookies<O>;
  container: DIContainer;
}

export type HandlerFn<
  Ctx extends Record<string, unknown>,
  K extends InputKind,
  O extends InputOptions<K>,
  Params extends Record<string, unknown>,
  Output,
> = (
  args: HandlerArgs<Ctx, K, O, Params>,
) => Output extends unknown
  ? Response | Promise<Response>
  : Response | Output | Promise<Response | Output>;

export type ErrorHandlerFn = (
  err: unknown,
  args: { req: Request },
) => Response | Promise<Response> | null | undefined | void;

// ---------------------------------------------------------------------------
// Route Definition (internal registry)
// ---------------------------------------------------------------------------

export interface RouteDefinition {
  method: HttpMethod;
  path: string;
  middlewares: MiddlewareFn<Record<string, unknown>, Record<string, unknown>>[];
  paramSchemas: Map<string, AnySchema>;
  inputKind: InputKind;
  inputOptions: InputOptions<InputKind>;
  outputSchema?: AnySchema;
  errorTypes?: (new (...args: unknown[]) => Error)[];
  meta?: RouteMeta;
  interceptors: InterceptorPair<Record<string, unknown>>[];
  handler: HandlerFn<
    Record<string, unknown>,
    InputKind,
    InputOptions<InputKind>,
    Record<string, unknown>,
    unknown
  >;
  errorHandler?: ErrorHandlerFn;
  kind: "http" | "ws" | "sse";
}

// ---------------------------------------------------------------------------
// DI Container Interface (minimal, v1)
// ---------------------------------------------------------------------------

export interface DIContainer {
  // deno-lint-ignore no-explicit-any
  get<T>(token: abstract new (...args: any[]) => T): T;
}

// ---------------------------------------------------------------------------
// Not Found Handler
// ---------------------------------------------------------------------------

export type NotFoundHandler = (req: Request) => Response | Promise<Response>;
