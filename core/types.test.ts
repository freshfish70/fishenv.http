import { expectTypeOf, test } from "bun:test";
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

test("ExtractParams — single param", () => {
  type R = ExtractParams<"/users/:id">;
  expectTypeOf<R>().toEqualTypeOf<"id">();
});

test("ExtractParams — multiple params", () => {
  type R = ExtractParams<"/users/:id/posts/:pid">;
  expectTypeOf<R>().toEqualTypeOf<"id" | "pid">();
});

test("ExtractParams — optional param", () => {
  type R = ExtractParams<"/users/:id?">;
  expectTypeOf<R>().toEqualTypeOf<"id">();
});

test("ExtractParams — rest param", () => {
  type R = ExtractParams<"/u/:id/:path*">;
  expectTypeOf<R>().toEqualTypeOf<"id" | "path">();
});

test("ExtractParams — no params", () => {
  type R = ExtractParams<"/users">;
  expectTypeOf<R>().toEqualTypeOf<never>();
});

test("ExtractParams — mixed required and optional", () => {
  type R = ExtractParams<"/a/:x/b/:y?">;
  expectTypeOf<R>().toEqualTypeOf<"x" | "y">();
});

test("ExtractParams — globs do not create params", () => {
  type R1 = ExtractParams<"/files/*">;
  type R2 = ExtractParams<"/files/**">;
  type R3 = ExtractParams<"/assets/*.{css,js}">;
  expectTypeOf<R1>().toEqualTypeOf<never>();
  expectTypeOf<R2>().toEqualTypeOf<never>();
  expectTypeOf<R3>().toEqualTypeOf<never>();
});

// ---------------------------------------------------------------------------
// BasePathParams
// ---------------------------------------------------------------------------

test("BasePathParams — params are strings", () => {
  type R = BasePathParams<"/users/:id">;
  expectTypeOf<R>().toEqualTypeOf<{ id: string }>();
});

test("BasePathParams — globs do not add params", () => {
  type R1 = BasePathParams<"/files/*">;
  type R2 = BasePathParams<"/files/**">;
  expectTypeOf<R1>().toEqualTypeOf<{}>();
  expectTypeOf<R2>().toEqualTypeOf<{}>();
});

test("BasePathParams — no params yields empty-ish", () => {
  type R = BasePathParams<"/users">;
  expectTypeOf<R>().toEqualTypeOf<{}>();
});

// ---------------------------------------------------------------------------
// MergeParam
// ---------------------------------------------------------------------------

test("MergeParam — overrides a key type", () => {
  type Base = { id: string; name: string };
  type Schema = ValibotSchema<number>;
  type R = MergeParam<Base, "id", Schema>;
  type IdType = R["id"];
  type NameType = R["name"];
  expectTypeOf<IdType>().toEqualTypeOf<number>();
  expectTypeOf<NameType>().toEqualTypeOf<string>();
});

// ---------------------------------------------------------------------------
// MergeCtx
// ---------------------------------------------------------------------------

test("MergeCtx — merges two context objects", () => {
  type A = { user: string };
  type B = { log: number };
  type R = MergeCtx<A, B>;
  expectTypeOf<R>().toEqualTypeOf<{ user: string } & { log: number }>();
});

// ---------------------------------------------------------------------------
// InferBody
// ---------------------------------------------------------------------------

test("InferBody — blob kind returns Blob", () => {
  type R = InferBody<"blob", InputOptions<"blob">>;
  expectTypeOf<R>().toEqualTypeOf<Blob>();
});

test("InferBody — text kind returns string", () => {
  type R = InferBody<"text", InputOptions<"text">>;
  expectTypeOf<R>().toEqualTypeOf<string>();
});

test("InferBody — none kind returns undefined", () => {
  type R = InferBody<"none", InputOptions<"none">>;
  expectTypeOf<R>().toEqualTypeOf<undefined>();
});

// ---------------------------------------------------------------------------
// InputKind — exhaustive check
// ---------------------------------------------------------------------------

test("InputKind — all variants", () => {
  type AllKinds =
    | "json"
    | "multipart"
    | "urlencoded"
    | "blob"
    | "text"
    | "none";
  expectTypeOf<InputKind>().toEqualTypeOf<AllKinds>();
});
