import type * as v from "valibot";
import type { HttpMethod } from "./types.ts";

const CODES: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  409: "conflict",
  422: "unprocessable_entity",
  429: "too_many_requests",
  500: "internal",
};

/** Stable machine-readable code for a status, e.g. `403` → `"forbidden"`. */
export function errorCodeForStatus(status: number): string {
  return CODES[status] ?? `http_${status}`;
}

/**
 * Transport-neutral error payload. HTTP responses and WebSocket replies are
 * both rendered from this, so they share one disclosure policy.
 */
export interface HttpErrorJSON {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  stack?: string;
}

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string, cause?: unknown) {
    super(message, { cause });
    this.status = status;
    this.name = "HttpError";
  }

  /** Machine-readable code. Override in subclasses for custom errors. */
  get code(): string {
    return errorCodeForStatus(this.status);
  }

  /** Extra public fields (e.g. validation issues). Never include secrets. */
  protected details(): Record<string, unknown> | undefined {
    return undefined;
  }

  /** The public payload; the stack is only included in development. */
  toJSON(development = false): HttpErrorJSON {
    const json: HttpErrorJSON = {
      status: this.status,
      code: this.code,
      message: this.message,
    };
    const details = this.details();
    if (details != null) json.details = details;
    if (development && this.stack) json.stack = this.stack;
    return json;
  }

  toResponse(development = false): Response {
    const json = this.toJSON(development);
    const body: Record<string, unknown> = { error: json.message };
    if (json.stack) body.stack = json.stack;
    return Response.json(body, { status: this.status });
  }
}

export class BadRequestError extends HttpError {
  constructor(message = "Bad Request", cause?: unknown) {
    super(400, message, cause);
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = "Unauthorized") {
    super(401, message);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = "Forbidden") {
    super(403, message);
  }
}

export class NotFoundError extends HttpError {
  constructor(message = "Not Found") {
    super(404, message);
  }
}

export class MethodNotAllowedError extends HttpError {
  constructor(message = "Method Not Allowed") {
    super(405, message);
  }
}

export class ConflictError extends HttpError {
  constructor(message = "Conflict", cause?: unknown) {
    super(409, message, cause);
  }
}

export class UnprocessableEntityError extends HttpError {
  constructor(message = "Unprocessable Entity", cause?: unknown) {
    super(422, message, cause);
  }
}

export class TooManyRequestsError extends HttpError {
  constructor(message = "Too Many Requests") {
    super(429, message);
  }
}

export class InternalServerError extends HttpError {
  constructor(message = "Internal Server Error", cause?: unknown) {
    super(500, message, cause);
  }
}

export type ValidationField = "body" | "headers" | "query" | "cookies" | "path";

export class ValidationError extends HttpError {
  readonly field: ValidationField;
  readonly issues: v.BaseIssue<unknown>[];

  constructor(field: ValidationField, issues: v.BaseIssue<unknown>[]) {
    super(400, "Validation Error");
    this.name = "ValidationError";
    this.field = field;
    this.issues = issues;
  }

  override get code(): string {
    return "validation_error";
  }

  protected override details(): Record<string, unknown> {
    return {
      field: this.field,
      issues: this.issues.map((i) => ({
        message: i.message,
        path: i.path?.map((p) => p.key) ?? [],
      })),
    };
  }

  override toResponse(): Response {
    return Response.json(
      { error: "ValidationError", ...this.details() },
      { status: 400 },
    );
  }
}

export interface ErrorHandlerOpts {
  development?: boolean;
  logger?: { error: (...args: unknown[]) => void };
}

export function defaultErrorHandler(
  err: unknown,
  _args: { req: Request },
  opts: ErrorHandlerOpts = {},
): Response {
  if (err instanceof HttpError) {
    return err.toResponse(opts.development);
  }
  const logger = opts.logger ?? console;
  logger.error("[fishenv.http] Unhandled error:", err);
  const body: Record<string, unknown> = { error: "Internal Server Error" };
  if (opts.development && err instanceof Error) body.stack = err.stack;
  return Response.json(body, { status: 500 });
}

export function defaultNotFoundHandler(req: Request): Response {
  return Response.json(
    { error: "Not Found", path: new URL(req.url).pathname },
    { status: 404 },
  );
}

export function defaultMethodNotAllowedHandler(
  _req: Request,
  allowed: HttpMethod[],
): Response {
  return new Response(null, {
    status: 405,
    headers: { Allow: allowed.join(", ") },
  });
}
