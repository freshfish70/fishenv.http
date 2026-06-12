import { assertType, type IsExact } from "@std/testing/types";
import type {
  BasePathParams,
  ExtractParams,
  InferBody,
  InputKind,
  InputOptions,
  MergeCtx,
  MergeParam,
  ValibotSchema,
} from "./types.ts";

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

Deno.test("ExtractParams — globs do not create params", () => {
  type R1 = ExtractParams<"/files/*">;
  type R2 = ExtractParams<"/files/**">;
  type R3 = ExtractParams<"/assets/*.{css,js}">;
  assertType<IsExact<R1, never>>(true);
  assertType<IsExact<R2, never>>(true);
  assertType<IsExact<R3, never>>(true);
});

// ---------------------------------------------------------------------------
// BasePathParams
// ---------------------------------------------------------------------------

Deno.test("BasePathParams — params are strings", () => {
  type R = BasePathParams<"/users/:id">;
  assertType<IsExact<R, { id: string }>>(true);
});

Deno.test("BasePathParams — globs do not add params", () => {
  type R1 = BasePathParams<"/files/*">;
  type R2 = BasePathParams<"/files/**">;
  assertType<IsExact<R1, {}>>(true);
  assertType<IsExact<R2, {}>>(true);
});

Deno.test("BasePathParams — no params yields empty-ish", () => {
  type R = BasePathParams<"/users">;
  assertType<IsExact<R, {}>>(true);
});

// ---------------------------------------------------------------------------
// MergeParam
// ---------------------------------------------------------------------------

Deno.test("MergeParam — overrides a key type", () => {
  type Base = { id: string; name: string };
  type Schema = ValibotSchema<number>;
  type R = MergeParam<Base, "id", Schema>;
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
  type AllKinds =
    | "json"
    | "multipart"
    | "urlencoded"
    | "blob"
    | "text"
    | "none";
  assertType<IsExact<InputKind, AllKinds>>(true);
});
