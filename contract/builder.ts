import type {
  AnySchema,
  BasePathParams,
  HttpMethod,
  InferOutput,
  InputKind,
  InputOptions,
  MergeParam,
  RouteMeta,
} from "./types.ts";

/**
 * Plain-data snapshot of a contract endpoint.
 *
 * This is the runtime shape consumers (the API's `router.contract()`, an
 * OpenAPI generator, a typed client, ...) read from. It intentionally has no
 * generic parameters — the compile-time shape lives on `ContractBuilder`
 * itself and is recovered via `ContractShape<C>`.
 */
export interface ContractDefinition {
  method: HttpMethod;
  path: string;
  paramSchemas: Map<string, AnySchema>;
  inputKind: InputKind;
  inputOptions: InputOptions<InputKind>;
  outputSchema?: AnySchema;
  errorTypes?: (new (...args: unknown[]) => Error)[];
  meta?: RouteMeta;
}

/**
 * Fluent, immutable contract endpoint builder.
 *
 * Mirrors `RouteBuilder` from `@fishenv/http` (method/path/param/input/output)
 * minus everything server-only (middleware, handlers, DI). A finished
 * `ContractBuilder` is portable data: it can be handed to
 * `router.contract(endpoint)` on the API side, or read by an OpenAPI
 * generator / typed client on the consumer side.
 */
export class ContractBuilder<
  M extends HttpMethod,
  P extends string,
  K extends InputKind = "none",
  O extends InputOptions<K> = InputOptions<K>,
  Params extends Record<string, unknown> = Record<string, unknown>,
  Output = undefined,
> {
  readonly method: M;
  readonly path: P;
  #paramSchemas: Map<string, AnySchema>;
  #inputKind: InputKind;
  #inputOptions: InputOptions<InputKind>;
  #outputSchema?: AnySchema;
  #errorTypes?: (new (...args: unknown[]) => Error)[];
  #meta?: RouteMeta;

  constructor(
    method: M,
    path: P,
    paramSchemas: Map<string, AnySchema> = new Map(),
    inputKind: InputKind = "none",
    inputOptions: InputOptions<InputKind> = {},
    outputSchema?: AnySchema,
    errorTypes?: (new (...args: unknown[]) => Error)[],
    meta?: RouteMeta,
  ) {
    this.method = method;
    this.path = path;
    this.#paramSchemas = paramSchemas;
    this.#inputKind = inputKind;
    this.#inputOptions = inputOptions;
    this.#outputSchema = outputSchema;
    this.#errorTypes = errorTypes;
    this.#meta = meta;
  }

  /** Set contract metadata (title, tags, etc.) — returns new builder */
  meta(data: RouteMeta): ContractBuilder<M, P, K, O, Params, Output> {
    return new ContractBuilder(
      this.method,
      this.path,
      new Map(this.#paramSchemas),
      this.#inputKind,
      this.#inputOptions,
      this.#outputSchema,
      this.#errorTypes ? [...this.#errorTypes] : undefined,
      { ...this.#meta, ...data },
    );
  }

  /** Narrow/coerce a path param with a Valibot schema — returns new builder */
  param<Name extends string & keyof Params, S extends AnySchema>(
    name: Name,
    schema: S,
  ): ContractBuilder<M, P, K, O, MergeParam<Params, Name, S>, Output> {
    const newSchemas = new Map(this.#paramSchemas);
    newSchemas.set(name, schema);
    return new ContractBuilder(
      this.method,
      this.path,
      newSchemas,
      this.#inputKind,
      this.#inputOptions,
      this.#outputSchema,
      this.#errorTypes ? [...this.#errorTypes] : undefined,
      this.#meta ? { ...this.#meta } : undefined,
    );
  }

  /** Set input kind and options — returns new builder */
  input<NK extends InputKind, NO extends InputOptions<NK>>(
    kind: NK,
    options?: NO,
  ): ContractBuilder<
    M,
    P,
    NK,
    NO extends InputOptions<NK> ? NO : InputOptions<NK>,
    Params,
    Output
  > {
    return new ContractBuilder(
      this.method,
      this.path,
      new Map(this.#paramSchemas),
      kind,
      (options ?? {}) as InputOptions<InputKind>,
      this.#outputSchema,
      this.#errorTypes ? [...this.#errorTypes] : undefined,
      this.#meta ? { ...this.#meta } : undefined,
    ) as ContractBuilder<
      M,
      P,
      NK,
      NO extends InputOptions<NK> ? NO : InputOptions<NK>,
      Params,
      Output
    >;
  }

  /** Set output schema + optional error types — returns new builder */
  output<S extends AnySchema>(
    schema: S,
    errors?: (new (...args: unknown[]) => Error)[],
  ): ContractBuilder<M, P, K, O, Params, InferOutput<S>> {
    return new ContractBuilder(
      this.method,
      this.path,
      new Map(this.#paramSchemas),
      this.#inputKind,
      this.#inputOptions,
      schema,
      errors,
      this.#meta ? { ...this.#meta } : undefined,
    );
  }

  /**
   * Runtime snapshot of this endpoint. Used by consumers such as
   * `router.contract()`, OpenAPI generation, or a typed client — not meant
   * to be read directly by application code.
   */
  get _definition(): ContractDefinition {
    return {
      method: this.method,
      path: this.path,
      paramSchemas: this.#paramSchemas,
      inputKind: this.#inputKind,
      inputOptions: this.#inputOptions,
      outputSchema: this.#outputSchema,
      errorTypes: this.#errorTypes,
      meta: this.#meta,
    };
  }
}

/**
 * Recovers the compile-time shape (input/output/params) of a `ContractBuilder`.
 * Used by consumers to derive their own generics from a contract endpoint.
 */
export type ContractShape<C> = C extends ContractBuilder<
  infer M,
  infer P,
  infer K,
  infer O,
  infer Params,
  infer Output
> ? { method: M; path: P; inputKind: K; inputOptions: O; params: Params; output: Output }
  : never;

/** Loosest possible `ContractBuilder` — use as a generic constraint. */
// deno-lint-ignore no-explicit-any
export type AnyContractBuilder = ContractBuilder<any, any, any, any, any, any>;

function endpoint<M extends HttpMethod>(method: M) {
  return <P extends string>(
    path: P,
  ): ContractBuilder<
    M,
    P,
    "none",
    InputOptions<"none">,
    BasePathParams<P>,
    undefined
  > => new ContractBuilder(method, path);
}

/**
 * Entry point for defining contract endpoints, e.g.:
 *
 * ```ts
 * export const contract = {
 *   users: {
 *     create: c.post("/users").input("json", { body: CreateUserSchema }).output(UserSchema),
 *     get: c.get("/users/:id").output(UserSchema),
 *   },
 * };
 * ```
 */
export const c = {
  get: endpoint("GET"),
  post: endpoint("POST"),
  put: endpoint("PUT"),
  patch: endpoint("PATCH"),
  delete: endpoint("DELETE"),
  options: endpoint("OPTIONS"),
};
