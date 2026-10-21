import { describe, expect, it } from "bun:test";
import * as v from "valibot";
import {
  BadRequestError,
  ConflictError,
  errorCodeForStatus,
  ForbiddenError,
  HttpError,
  InternalServerError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
  UnprocessableEntityError,
  ValidationError,
} from "./error.ts";

describe("HttpError.code", () => {
  it.each([
    [new BadRequestError(), "bad_request"],
    [new UnauthorizedError(), "unauthorized"],
    [new ForbiddenError(), "forbidden"],
    [new NotFoundError(), "not_found"],
    [new ConflictError(), "conflict"],
    [new UnprocessableEntityError(), "unprocessable_entity"],
    [new TooManyRequestsError(), "too_many_requests"],
    [new InternalServerError(), "internal"],
  ] as const)("%p → %s", (err, code) => {
    expect(err.code).toEqual(code);
  });

  it("falls back to http_<status> for unmapped statuses", () => {
    expect(new HttpError(418, "teapot").code).toEqual("http_418");
    expect(errorCodeForStatus(418)).toEqual("http_418");
  });

  it("subclasses can override the code", () => {
    class QuotaError extends HttpError {
      constructor() {
        super(429, "Quota exceeded");
      }
      override get code() {
        return "quota_exceeded";
      }
    }
    expect(new QuotaError().toJSON().code).toEqual("quota_exceeded");
  });
});

describe("HttpError.toJSON", () => {
  it("contains status, code and message only in production", () => {
    expect(new ForbiddenError("No access").toJSON()).toEqual({
      status: 403,
      code: "forbidden",
      message: "No access",
    });
  });

  it("includes the stack only in development", () => {
    const err = new ForbiddenError();
    expect(err.toJSON(false).stack).toBeUndefined();
    expect(err.toJSON(true).stack).toContain("Forbidden");
  });

  it("never exposes the cause", () => {
    const err = new BadRequestError("bad", new Error("db password=hunter2"));
    expect(JSON.stringify(err.toJSON(true))).not.toContain("hunter2");
  });

  it("JSON.stringify uses the production payload", () => {
    const err = new NotFoundError("gone");
    expect(JSON.parse(JSON.stringify(err))).toEqual({
      status: 404,
      code: "not_found",
      message: "gone",
    });
  });

  it("ValidationError carries field + issues as details", () => {
    const result = v.safeParse(v.object({ n: v.number() }), { n: "x" });
    const err = new ValidationError("body", result.issues!);
    const json = err.toJSON();
    expect(json.code).toEqual("validation_error");
    expect(json.status).toEqual(400);
    expect(json.details?.field).toEqual("body");
    expect(json.details?.issues).toEqual([
      { message: expect.any(String), path: ["n"] },
    ]);
  });
});

describe("HttpError.toResponse stays backward compatible", () => {
  it("renders { error } with the status", async () => {
    const res = new UnauthorizedError("Missing token").toResponse();
    expect(res.status).toEqual(401);
    expect(await res.json()).toEqual({ error: "Missing token" });
  });

  it("ValidationError keeps its body shape", async () => {
    const result = v.safeParse(v.string(), 1);
    const res = new ValidationError("query", result.issues!).toResponse();
    const body = await res.json();
    expect(body.error).toEqual("ValidationError");
    expect(body.field).toEqual("query");
    expect(body.issues).toHaveLength(1);
  });
});
