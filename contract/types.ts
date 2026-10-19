import type * as v from "valibot";

/**
 * `@fishenv/http-contract` — the "shape" types shared between an API and its
 * consumers (the API itself, an OpenAPI generator, a typed client, ...).
 *
 * This module has zero server-runtime dependencies (no DI, no middleware, no
 * `Bun.serve`) — it only describes *what* an endpoint looks like: method,
 * path, input, output. `@fishenv/http` (the `core` package) depends on this
 * package to build its route registration API; this package must never
 * depend back on `core`.
 */

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
// HTTP Method
// ---------------------------------------------------------------------------

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS"
  | "HEAD";

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

export type InferBody<
  K extends InputKind,
  O extends InputOptions<K>,
> = K extends "blob"
  ? Blob
  : K extends "text"
    ? string
    : K extends "none"
      ? undefined
      : O["body"] extends AnySchema
        ? InferOutput<O["body"]>
        : K extends "multipart" | "urlencoded"
          ? FormData
          : unknown;

export type InferHeaders<O extends InputOptions<InputKind>> =
  O["headers"] extends AnySchema
    ? InferOutput<O["headers"]>
    : Record<string, string>;

export type InferQuery<O extends InputOptions<InputKind>> =
  O["query"] extends AnySchema
    ? InferOutput<O["query"]>
    : Record<string, string | string[]>;

export type InferCookies<O extends InputOptions<InputKind>> =
  O["cookies"] extends AnySchema
    ? InferOutput<O["cookies"]>
    : Record<string, string>;

// ---------------------------------------------------------------------------
// Path Param Extraction
// ---------------------------------------------------------------------------

type ParamName<Param extends string> = Param extends `${infer Name}?`
  ? Name
  : Param extends `${infer Name}*`
    ? Name
    : Param;

export type ExtractParams<P extends string> =
  P extends `${string}:${infer Param}/${infer Rest}`
    ? ParamName<Param> | ExtractParams<`/${Rest}`>
    : P extends `${string}:${infer Param}`
      ? ParamName<Param>
      : never;

export type BasePathParams<P extends string> = {
  [K in ExtractParams<P>]: string;
};

export type MergeParam<
  Base extends Record<string, unknown>,
  Name extends string,
  Schema extends AnySchema,
> = Omit<Base, Name> & Record<Name, InferOutput<Schema>>;

// ---------------------------------------------------------------------------
// Route Metadata
// ---------------------------------------------------------------------------

export interface RouteMeta {
  title?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  operationId?: string;
}

/**
 * Error classes a handler may throw — documentation and client typing only
 * (`.output(schema, errors)`, WebSocket replies). `any[]` so that classes with
 * typed constructor params (`ForbiddenError(message?: string)`) fit.
 */
// biome-ignore lint/suspicious/noExplicitAny: constructor params are contravariant
export type ErrorTypes = (abstract new (...args: any[]) => Error)[];
