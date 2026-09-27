import { assertEquals } from "@std/assert";
import { assertType, type IsExact } from "@std/testing/types";
import * as v from "valibot";
import { c, type ContractShape } from "./mod.ts";

Deno.test("c.post — builds a definition snapshot", () => {
  const CreateUser = v.object({ name: v.string() });
  const endpoint = c.post("/users").input("json", { body: CreateUser });
  const def = endpoint._definition;

  assertEquals(def.method, "POST");
  assertEquals(def.path, "/users");
  assertEquals(def.inputKind, "json");
  assertEquals(def.inputOptions.body, CreateUser);
});

Deno.test("c.get — param schema narrows path param type", () => {
  const NumericId = v.pipe(v.string(), v.transform(Number));
  const endpoint = c.get("/users/:id").param("id", NumericId);
  const def = endpoint._definition;

  assertEquals(def.paramSchemas.get("id"), NumericId);

  type Shape = ContractShape<typeof endpoint>;
  assertType<IsExact<Shape["params"], { id: number }>>(true);
});

Deno.test("c.get — output schema is reflected in ContractShape", () => {
  const UserSchema = v.object({ id: v.number(), name: v.string() });
  const endpoint = c.get("/users/:id").output(UserSchema);

  type Shape = ContractShape<typeof endpoint>;
  assertType<IsExact<Shape["output"], { id: number; name: string }>>(true);
});

Deno.test("builders are immutable — each call returns a distinct instance", () => {
  const base = c.get("/users");
  const withOutput = base.output(v.object({ ok: v.boolean() }));

  assertEquals(base === (withOutput as unknown), false);
  assertEquals(base._definition.outputSchema, undefined);
});
