import { expect, expectTypeOf, test } from "bun:test";
import * as v from "valibot";
import { ForbiddenError, NotFoundError } from "../core/error.ts";
import { type ContractShape, c } from "./index.ts";

test("c.post — builds a definition snapshot", () => {
  const CreateUser = v.object({ name: v.string() });
  const endpoint = c.post("/users").input("json", { body: CreateUser });
  const def = endpoint._definition;

  expect(def.method).toEqual("POST");
  expect(def.path).toEqual("/users");
  expect(def.inputKind).toEqual("json");
  expect(def.inputOptions.body).toEqual(CreateUser);
});

test("c.get — param schema narrows path param type", () => {
  const NumericId = v.pipe(v.string(), v.transform(Number));
  const endpoint = c.get("/users/:id").param("id", NumericId);
  const def = endpoint._definition;

  expect(def.paramSchemas.get("id")).toEqual(NumericId);

  type Shape = ContractShape<typeof endpoint>;
  expectTypeOf<Shape["params"]>().branded.toEqualTypeOf<{ id: number }>();
});

test("c.get — output schema is reflected in ContractShape", () => {
  const UserSchema = v.object({ id: v.number(), name: v.string() });
  const endpoint = c.get("/users/:id").output(UserSchema);

  type Shape = ContractShape<typeof endpoint>;
  expectTypeOf<Shape["output"]>().toEqualTypeOf<{ id: number; name: string }>();
});

test("builders are immutable — each call returns a distinct instance", () => {
  const base = c.get("/users");
  const withOutput = base.output(v.object({ ok: v.boolean() }));

  expect(base === (withOutput as unknown)).toEqual(false);
  expect(base._definition.outputSchema).toEqual(undefined);
});

test("c.get — output() accepts the built-in HTTP error classes", () => {
  const endpoint = c
    .get("/users/:id")
    .output(v.object({ id: v.string() }), [ForbiddenError, NotFoundError]);
  expect(endpoint._definition.errorTypes).toEqual([
    ForbiddenError,
    NotFoundError,
  ]);
});
