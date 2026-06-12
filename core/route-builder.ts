import type {
  AfterInterceptorFn,
  AnySchema,
  BasePathParams,
  BeforeInterceptorFn,
  ErrorHandlerFn,
  HandlerArgs,
  HandlerFn,
  HttpMethod,
  InferBody,
  InferCookies,
  InferHeaders,
  InferOutput,
  InferQuery,
  InputKind,
  InputOptions,
  InterceptorPair,
  MergeParam,
  MiddlewareFn,
  RouteDefinition,
  RouteMeta,
} from "./types.ts";

/**
 * Internal interface — the Router class (step 06) will implement this.
 * Allows RouteBuilder to register completed routes without a circular dependency.
 */
export interface RouterRef {
  _registerRoute(def: RouteDefinition): void;
  _getMiddlewares(): MiddlewareFn<
    Record<string, unknown>,
    Record<string, unknown>
  >[];
  _getPrefix(): string;
}

/**
 * A completed route — returned by `RouteBuilder.handle()`.
 * Exposes the route definition for testing/introspection and allows `.catch()`.
 */
export class FinishedRoute {
  readonly definition: RouteDefinition;

  constructor(definition: RouteDefinition) {
    this.definition = definition;
  }

  catch(fn: ErrorHandlerFn): this {
    this.definition.errorHandler = fn;
    return this;
  }
}

/**
 * Fluent route builder chain.
 *
 * Each method that changes generic type params returns a new instance.
 * Methods that only add runtime data (.meta(), .intercept()) mutate and return `this`.
 */
export class RouteBuilder<
  RouterCtx extends object,
  RouteCtx extends object,
  K extends InputKind = "none",
  O extends InputOptions<K> = InputOptions<K>,
  Params extends Record<string, unknown> = Record<string, unknown>,
  Output = undefined,
> {
  readonly #router: RouterRef;
  readonly #method: HttpMethod;
  readonly #path: string;
  #middlewares: MiddlewareFn<
    Record<string, unknown>,
    Record<string, unknown>
  >[];
  #paramSchemas: Map<string, AnySchema>;
  #inputKind: InputKind;
  #inputOptions: InputOptions<InputKind>;
  #outputSchema?: AnySchema;
  #errorTypes?: (new (...args: unknown[]) => Error)[];
  #meta?: RouteMeta;
  #interceptors: InterceptorPair<Record<string, unknown>>[];

  constructor(
    router: RouterRef,
    method: HttpMethod,
    path: string,
    middlewares: MiddlewareFn<
      Record<string, unknown>,
      Record<string, unknown>
    >[] = [],
    paramSchemas: Map<string, AnySchema> = new Map(),
    inputKind: InputKind = "none",
    inputOptions: InputOptions<InputKind> = {},
    outputSchema?: AnySchema,
    errorTypes?: (new (...args: unknown[]) => Error)[],
    meta?: RouteMeta,
    interceptors: InterceptorPair<Record<string, unknown>>[] = [],
  ) {
    this.#router = router;
    this.#method = method;
    this.#path = path;
    this.#middlewares = middlewares;
    this.#paramSchemas = paramSchemas;
    this.#inputKind = inputKind;
    this.#inputOptions = inputOptions;
    this.#outputSchema = outputSchema;
    this.#errorTypes = errorTypes;
    this.#meta = meta;
    this.#interceptors = interceptors;
  }

  /** Set route metadata (title, tags, etc.) — mutates, returns this */
  meta(data: RouteMeta): this {
    this.#meta = { ...this.#meta, ...data };
    return this;
  }

  /** Narrow/coerce a path param with a Valibot schema — returns new builder */
  param<Name extends string & keyof Params, S extends AnySchema>(
    name: Name,
    schema: S,
  ): RouteBuilder<
    RouterCtx,
    RouteCtx,
    K,
    O,
    MergeParam<Params, Name, S>,
    Output
  > {
    const newSchemas = new Map(this.#paramSchemas);
    newSchemas.set(name, schema);
    return new RouteBuilder(
      this.#router,
      this.#method,
      this.#path,
      [...this.#middlewares],
      newSchemas,
      this.#inputKind,
      this.#inputOptions,
      this.#outputSchema,
      this.#errorTypes ? [...this.#errorTypes] : undefined,
      this.#meta ? { ...this.#meta } : undefined,
      [...this.#interceptors],
    );
  }

  /** Add route-level middleware — returns new builder with extended context */
  with<NewCtx extends Record<string, unknown>>(
    mw: MiddlewareFn<RouterCtx & RouteCtx, NewCtx>,
  ): RouteBuilder<RouterCtx, RouteCtx & NewCtx, K, O, Params, Output> {
    return new RouteBuilder(
      this.#router,
      this.#method,
      this.#path,
      [
        ...this.#middlewares,
        mw as MiddlewareFn<Record<string, unknown>, Record<string, unknown>>,
      ],
      new Map(this.#paramSchemas),
      this.#inputKind,
      this.#inputOptions,
      this.#outputSchema,
      this.#errorTypes ? [...this.#errorTypes] : undefined,
      this.#meta ? { ...this.#meta } : undefined,
      [...this.#interceptors],
    );
  }

  /** Set input kind and options — returns new builder */
  input<NK extends InputKind, NO extends InputOptions<NK>>(
    kind: NK,
    options?: NO,
  ): RouteBuilder<
    RouterCtx,
    RouteCtx,
    NK,
    NO extends InputOptions<NK> ? NO : InputOptions<NK>,
    Params,
    Output
  > {
    return new RouteBuilder(
      this.#router,
      this.#method,
      this.#path,
      [...this.#middlewares],
      new Map(this.#paramSchemas),
      kind,
      (options ?? {}) as InputOptions<InputKind>,
      this.#outputSchema,
      this.#errorTypes ? [...this.#errorTypes] : undefined,
      this.#meta ? { ...this.#meta } : undefined,
      [...this.#interceptors],
    ) as RouteBuilder<
      RouterCtx,
      RouteCtx,
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
  ): RouteBuilder<RouterCtx, RouteCtx, K, O, Params, InferOutput<S>> {
    return new RouteBuilder(
      this.#router,
      this.#method,
      this.#path,
      [...this.#middlewares],
      new Map(this.#paramSchemas),
      this.#inputKind,
      this.#inputOptions,
      schema,
      errors,
      this.#meta ? { ...this.#meta } : undefined,
      [...this.#interceptors],
    );
  }

  /** Add a before/after interceptor pair — mutates, returns this */
  intercept(
    before?: BeforeInterceptorFn<RouterCtx & RouteCtx>,
    after?: AfterInterceptorFn<RouterCtx & RouteCtx>,
  ): this {
    this.#interceptors.push({
      before: before as
        | BeforeInterceptorFn<Record<string, unknown>>
        | undefined,
      after: after as AfterInterceptorFn<Record<string, unknown>> | undefined,
    });
    return this;
  }

  /** Terminal — registers the route on the router and returns a FinishedRoute */
  handle(
    fn: (
      args: HandlerArgs<RouterCtx & RouteCtx, K, O, Params>,
    ) => Output extends undefined ? Response | Promise<Response>
      : Response | Output | Promise<Response | Output>,
  ): FinishedRoute {
    const fullPath = this.#router._getPrefix()
      ? `${this.#router._getPrefix()}${this.#path}`
      : this.#path;

    const routerMiddlewares = this.#router._getMiddlewares();

    const definition: RouteDefinition = {
      method: this.#method,
      path: fullPath,
      middlewares: [...routerMiddlewares, ...this.#middlewares],
      paramSchemas: this.#paramSchemas,
      inputKind: this.#inputKind,
      inputOptions: this.#inputOptions,
      outputSchema: this.#outputSchema,
      errorTypes: this.#errorTypes,
      meta: this.#meta,
      interceptors: this.#interceptors,
      handler: fn as RouteDefinition["handler"],
      kind: "http",
    };

    this.#router._registerRoute(definition);
    return new FinishedRoute(definition);
  }
}

/**
 * Factory — creates a RouteBuilder bound to a router reference.
 * Used internally by the Router class method helpers (.get(), .post(), etc.)
 */
export function createRouteBuilder<
  RouterCtx extends object,
  P extends string,
>(
  router: RouterRef,
  method: HttpMethod,
  path: P,
): RouteBuilder<
  RouterCtx,
  Record<never, never>,
  "none",
  InputOptions<"none">,
  BasePathParams<P>,
  undefined
> {
  return new RouteBuilder(
    router,
    method,
    path,
  );
}
