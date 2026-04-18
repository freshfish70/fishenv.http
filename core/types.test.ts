import { assertType, type IsExact } from "@std/testing/types";
import type {
  AnySchema,
  BasePathParams,
  ExtractParams,
  HandlerArgs,
  HandlerFn,
  InferBody,
  InferCookies,
  InferHeaders,
  InferQuery,
  InputKind,
  InputOptions,
  MergeCtx,
  MergeParam,
  ValibotSchema,
} from "./types.ts";
import type * as v from "valibot";

// ---------------------------------------------------------------------------
// ExtractParams
// ---------------------------------------------------------------------------

Deno.test("ExtractParams — single param", () => {
  type R = ExtractParams<"/users/:id">;
  assertType<IsExact<R, "id">>(true);
});

Deno.test("ExtractParams — multiple params", () => {
  type R = ExtractParams<"/users/:id/posts/:pid">;
  assertType<IsExact<R, "id" | "pid">>(true);
});

Deno.test("ExtractParams — optional param", () => {
  type R = ExtractParams<"/users/:id?">;
  assertType<IsExact<R, "id">>(true);
});

Deno.test("ExtractParams — no params", () => {
  type R = ExtractParams<"/users">;
  assertType<IsExact<R, never>>(true);
});

Deno.test("ExtractParams — mixed required and optional", () => {
  type R = ExtractParams<"/a/:x/b/:y?">;
  assertType<IsExact<R, "x" | "y">>(true);
});

// ---------------------------------------------------------------------------
// BasePathParams
// ---------------------------------------------------------------------------

Deno.test("BasePathParams — params are strings", () => {
  type R = BasePathParams<"/users/:id">;
  assertType<IsExact<R, { id: string }>>(true);
});

Deno.test("BasePathParams — wildcard adds * key", () => {
  type R = BasePathParams<"/files/*">;
  // Should have { "*": string }
  type HasWildcard = R extends { "*": string } ? true : false;
  assertType<IsExact<HasWildcard, true>>(true);
});

Deno.test("BasePathParams — no params yields empty-ish", () => {
  type R = BasePathParams<"/users">;
  // ExtractParams<"/users"> = never → Record<never, string> = {}
  assertType<IsExact<R, {}> >(true);
});

// ---------------------------------------------------------------------------
// MergeParam
// ---------------------------------------------------------------------------

Deno.test("MergeParam — overrides a key type", () => {
  type Base = { id: string; name: string };
  type Schema = ValibotSchema<number>;
  type R = MergeParam<Base, "id", Schema>;
  // id should now be number, name stays string
  type IdType = R["id"];
  type NameType = R["name"];
  assertType<IsExact<IdType, number>>(true);
  assertType<IsExact<NameType, string>>(true);
});

// ---------------------------------------------------------------------------
// MergeCtx
// ---------------------------------------------------------------------------

Deno.test("MergeCtx — merges two context objects", () => {
  type A = { user: string };
  type B = { log: number };
  type R = MergeCtx<A, B>;
  assertType<IsExact<R, { user: string } & { log: number }>>(true);
});

// ---------------------------------------------------------------------------
// InferBody
// ---------------------------------------------------------------------------

Deno.test("InferBody — blob kind returns Blob", () => {
  type R = InferBody<"blob", InputOptions<"blob">>;
  assertType<IsExact<R, Blob>>(true);
});

Deno.test("InferBody — text kind returns string", () => {
  type R = InferBody<"text", InputOptions<"text">>;
  assertType<IsExact<R, string>>(true);
});

Deno.test("InferBody — none kind returns undefined", () => {
  type R = InferBody<"none", InputOptions<"none">>;
  assertType<IsExact<R, undefined>>(true);
});

// ---------------------------------------------------------------------------
// InputKind — exhaustive check
// ---------------------------------------------------------------------------

Deno.test("InputKind — all variants", () => {
  type AllKinds = "json" | "multipart" | "urlencoded" | "blob" | "text" | "none";
  assertType<IsExact<InputKind, AllKinds>>(true);
});
