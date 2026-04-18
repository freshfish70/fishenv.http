import type * as v from "valibot";
import type { HttpMethod } from "./types.ts";

export class HttpError extends Error {
  readonly status: number;

  constructor(
    status: number,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.status = status;
    this.name = "HttpError";
  }

  toResponse(development = false): Response {
    const body: Record<string, unknown> = { error: this.message };
    if (development && this.stack) body.stack = this.stack;
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

  constructor(
    field: ValidationField,
    issues: v.BaseIssue<unknown>[],
  ) {
    super(400, "Validation Error");
    this.name = "ValidationError";
    this.field = field;
    this.issues = issues;
  }

  override toResponse(): Response {
    return Response.json({
      error: "ValidationError",
      field: this.field,
      issues: this.issues.map((i) => ({
        message: i.message,
        path: i.path?.map((p) => p.key) ?? [],
      })),
    }, { status: 400 });
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
