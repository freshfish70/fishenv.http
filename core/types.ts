import type * as v from "valibot";

// ---------------------------------------------------------------------------
// Schema Types (Valibot-based, Standard Schema-compatible shape)
// ---------------------------------------------------------------------------

export type ValibotSchema<O = unknown> = v.BaseSchema<
  unknown,
  O,
  v.BaseIssue<unknown>
>;

export type AnySchema = ValibotSchema<unknown>;

export type InferOutput<S extends AnySchema> = v.InferOutput<S>;

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

export type InputKind =
  | "json"
  | "multipart"
  | "urlencoded"
  | "blob"
  | "text"
  | "none";

export interface InputOptions<K extends InputKind> {
  body?: K extends "blob" | "text" ? never : AnySchema;
  headers?: AnySchema;
  query?: AnySchema;
  cookies?: AnySchema;
  maxSize?: K extends "blob" | "multipart" ? number : never;
}

export interface ResolvedInput<K extends InputKind, O extends InputOptions<K>> {
  kind: K;
  options: O;
}

export type InferBody<K extends InputKind, O extends InputOptions<K>> =
  K extends "blob" ? Blob
    : K extends "text" ? string
    : K extends "none" ? undefined
    : O["body"] extends AnySchema ? InferOutput<O["body"]>
    : K extends "multipart" | "urlencoded" ? FormData
    : unknown;

export type InferHeaders<O extends InputOptions<InputKind>> =
  O["headers"] extends AnySchema ? InferOutput<O["headers"]>
    : Record<string, string>;

export type InferQuery<O extends InputOptions<InputKind>> =
  O["query"] extends AnySchema ? InferOutput<O["query"]>
    : Record<string, string | string[]>;

export type InferCookies<O extends InputOptions<InputKind>> =
  O["cookies"] extends AnySchema ? InferOutput<O["cookies"]>
    : Record<string, string>;

// ---------------------------------------------------------------------------
// Path Param Extraction
// ---------------------------------------------------------------------------

export type ExtractParams<P extends string> = P extends
  `${string}:${infer Param}/${infer Rest}`
  ? (Param extends `${infer Name}?` ? Name : Param) | ExtractParams<`/${Rest}`>
  : P extends `${string}:${infer Param}`
    ? Param extends `${infer Name}?` ? Name : Param
  : never;

export type BasePathParams<P extends string> =
  & { [K in ExtractParams<P>]: string }
  & (P extends `${string}*` ? { "*": string } : unknown);

export type MergeParam<
  Base extends Record<string, unknown>,
  Name extends string,
  Schema extends AnySchema,
> = Omit<Base, Name> & Record<Name, InferOutput<Schema>>;

// ---------------------------------------------------------------------------
// Middleware Types
// ---------------------------------------------------------------------------

export type MiddlewareFn<
  In extends Record<string, unknown>,
  Out extends Record<string, unknown>,
> = (ctx: In & { req: Request }) => Promise<Out> | Out;

export type MergeCtx<
  A extends Record<string, unknown>,
  B extends Record<string, unknown>,
> = A & B;

// ---------------------------------------------------------------------------
// Interceptor Types
// ---------------------------------------------------------------------------

export type InterceptorState = Record<string, unknown>;

export type BeforeInterceptorFn<Ctx extends Record<string, unknown>> = (
  args: { req: Request; ctx: Ctx; state: InterceptorState },
) => Promise<void> | void;

export type AfterInterceptorFn<Ctx extends Record<string, unknown>> = (
  args: { response: Response; ctx: Ctx; state: InterceptorState },
) => Promise<Response> | Response;

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
) => Output extends unknown ? Response | Promise<Response>
  : Response | Output | Promise<Response | Output>;

export type ErrorHandlerFn = (
  err: unknown,
  args: { req: Request },
) => Response | Promise<Response> | null | undefined | void;

// ---------------------------------------------------------------------------
// Route Definition (internal registry)
// ---------------------------------------------------------------------------

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS"
  | "HEAD";

export interface RouteMeta {
  title?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  operationId?: string;
}

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
