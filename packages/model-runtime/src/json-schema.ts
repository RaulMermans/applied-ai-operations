import { Ajv, type ValidateFunction } from "ajv";
import type { JsonObject } from "@aao/contracts";

/**
 * AAO's deterministic structured-output boundary, delegated to Ajv (an
 * established JSON Schema validator) rather than a home-grown one. Each call
 * builds a fresh Ajv instance, so no compiled-schema cache or other hidden
 * module-level state survives between calls.
 *
 * Ajv runs in strict mode, so an unknown keyword or unknown `format` makes a
 * schema *invalid* (fail closed) rather than silently ignored. V1 also
 * requires the top-level schema to describe an object (`"type": "object"`),
 * matching what structured-output providers accept.
 */
export function compileOutputSchema(schema: JsonObject): { ok: true; validate: (value: unknown) => boolean } | { ok: false; issues: string[] } {
  if (schema.type !== "object") {
    return { ok: false, issues: ['structured output schema must declare "type": "object" at the top level'] };
  }
  let validate: ValidateFunction;
  try {
    validate = new Ajv({ strict: true, allErrors: false }).compile(schema);
  } catch {
    return { ok: false, issues: ["structured output schema is not a valid (strict) JSON Schema"] };
  }
  return { ok: true, validate: (value: unknown) => validate(value) === true };
}
