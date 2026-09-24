import { isJsonSafe } from "@aao/runtime";
import { compileOutputSchema } from "./json-schema.js";
import { ModelRequestSchema, type ModelFailure, type ModelRequest } from "./types.js";

/**
 * Validates an untrusted value as a `ModelRequest` before any routing or
 * adapter invocation: canonical JSON-safety (the same `isJsonSafe` the
 * workflow Runtime uses — no second JSON-safety implementation), the
 * request schema, and — for structured output — that the schema compiles as
 * a strict JSON Schema.
 */
export function validateModelRequest(value: unknown): { ok: true; request: ModelRequest } | { ok: false; failure: ModelFailure } {
  if (!isJsonSafe(value)) {
    return { ok: false, failure: { code: "INVALID_MODEL_REQUEST", message: "Model request is not JSON-safe." } };
  }
  const parsed = ModelRequestSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      failure: {
        code: "INVALID_MODEL_REQUEST",
        message: "Model request does not match ModelRequestSchema.",
        details: { issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`) },
      },
    };
  }
  const request = parsed.data;
  if (request.output.kind === "structured") {
    const compiled = compileOutputSchema(request.output.schema);
    if (!compiled.ok) {
      return {
        ok: false,
        failure: { code: "INVALID_MODEL_REQUEST", message: "Model request has an invalid structured output schema.", invocationId: request.invocationId, details: { issues: compiled.issues } },
      };
    }
  }
  return { ok: true, request };
}
