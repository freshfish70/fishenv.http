/**
 * The contract — pure data describing the API's shape.
 *
 * This file only depends on `@fishenv/http-contract` + a schema library (valibot),
 * so it can live in its own package/repo and be shared between the API and
 * any consumer (frontend client, OpenAPI generator, ...).
 */
import { c } from "@fishenv/http-contract";
import * as v from "valibot";

const CreateUserSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1, "Name is required")),
  email: v.pipe(v.string(), v.email("Invalid email")),
});

const UserOutputSchema = v.object({
  id: v.string(),
  name: v.string(),
  email: v.string(),
});

const NumericId = v.pipe(
  v.string(),
  v.transform(Number),
  v.number("ID must be numeric"),
  v.integer("ID must be an integer"),
);

export const contract = {
  users: {
    create: c
      .post("/users")
      .input("json", { body: CreateUserSchema })
      .output(UserOutputSchema),

    get: c.get("/users/:id").param("id", NumericId).output(UserOutputSchema),
  },
};
