// Types
export type {
  AfterInterceptorFn,
  AnySchema,
  BasePathParams,
  BeforeInterceptorFn,
  DIContainer,
  ErrorHandlerFn,
  ExtractParams,
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
  InterceptorState,
  MergeCtx,
  MergeParam,
  MiddlewareFn,
  NotFoundHandler,
  ResolvedInput,
  RouteDefinition,
  RouteMeta,
  ValibotSchema,
} from "./types.ts";

// Matcher
export { Matcher } from "./matcher.ts";
export type { MatchedRoute, RouterMatcher } from "./matcher.ts";

// Compose (pipeline)
export {
  coerceToResponse,
  dispatch,
  runInterceptors,
  runMiddlewarePipeline,
} from "./compose.ts";

// Route Builder
export { createRouteBuilder, FinishedRoute, RouteBuilder } from "./route-builder.ts";
export type { RouterRef } from "./route-builder.ts";

// Router
export { r, Router, router, serve } from "./router.ts";
export type { Logger, ServeOptions } from "./router.ts";

// Errors
export {
  BadRequestError,
  ConflictError,
  defaultErrorHandler,
  defaultMethodNotAllowedHandler,
  defaultNotFoundHandler,
  ForbiddenError,
  HttpError,
  InternalServerError,
  MethodNotAllowedError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
  UnprocessableEntityError,
  ValidationError,
} from "./error.ts";
export type { ValidationField } from "./error.ts";

// Request parsing
export {
  extractHeaders,
  extractQuery,
  parseBody,
  parseCookies,
  parseInput,
} from "./request.ts";
export type { ParsedInput } from "./request.ts";

// Validation
export { validateField, validatePathParams } from "./validation.ts";

// URL utilities
export {
  buildRouteRegex,
  extractParamNames,
  mergePaths,
} from "./utils/url.ts";
