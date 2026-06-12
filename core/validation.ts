import * as v from "valibot";
import type { AnySchema } from "./types.ts";
import { ValidationError, type ValidationField } from "./error.ts";

/**
 * Validate a single field value against a Valibot schema.
 * Throws ValidationError on failure.
 */
export function validateField<S extends AnySchema>(
  schema: S,
  value: unknown,
  field: ValidationField,
): v.InferOutput<S> {
  const result = v.safeParse(schema, value);
  if (!result.success) {
    throw new ValidationError(field, result.issues);
  }
  return result.output;
}

/**
 * Validate path params: each param with a registered schema gets validated/coerced.
 * Params without schemas pass through as raw strings.
 */
export function validatePathParams(
  rawParams: Record<string, string>,
  schemas: Map<string, AnySchema>,
): Record<string, unknown> {
  const validated: Record<string, unknown> = { ...rawParams };
  for (const [name, schema] of schemas) {
    validated[name] = validateField(schema, rawParams[name], "path");
  }
  return validated;
}
