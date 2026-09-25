import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import type { JsonObject } from "@aao/contracts";

/** A compiled, reusable, side-effect-free JSON Schema check. */
export interface CompiledToolSchema {
  /** `issues` are Ajv's deterministic error messages with the offending instance path — never the offending value itself. */
  validate(value: unknown): { ok: true } | { ok: false; issues: string[] };
}

/**
 * The Tool Runtime's JSON Schema policy, delegated to Ajv (the same
 * validator Model Runtime uses) rather than a home-grown or proprietary
 * schema language. Fail closed — if Ajv cannot reliably enforce a schema,
 * the Tool cannot be registered:
 *
 * - Ajv's default dialect (draft-07). A `$schema` naming any other dialect
 *   is unknown to this instance and fails compilation.
 * - `strict: true`: an unknown keyword, an ignored keyword combination, or
 *   an unknown `format` makes the schema invalid instead of being silently
 *   skipped. No format plugin is installed, so every `format` fails closed.
 * - No remote `$ref` loading, no `$data`, and no `$async` schemas (an async
 *   validator returns a Promise, which is not a synchronous verdict).
 * - No input mutation: `useDefaults`, `coerceTypes`, and `removeAdditional`
 *   stay at their `false` defaults, so validation never rewrites data.
 *
 * Each schema gets a fresh Ajv instance, so no compiled-schema cache or
 * `$id` namespace is shared between Tools or registries.
 */
export function compileToolSchema(schema: JsonObject): { ok: true; schema: CompiledToolSchema } | { ok: false; issues: string[] } {
  if (schema.$async !== undefined) return { ok: false, issues: ["$async schemas are not supported"] };
  let validate: ValidateFunction;
  try {
    validate = new Ajv({ strict: true, allErrors: false }).compile(schema);
  } catch {
    return { ok: false, issues: ["schema is not a valid JSON Schema under the strict Tool Runtime V1 policy"] };
  }
  if ((validate as { $async?: unknown }).$async === true) return { ok: false, issues: ["$async schemas are not supported"] };
  return {
    ok: true,
    schema: {
      validate(value) {
        if (validate(value) === true) return { ok: true };
        return { ok: false, issues: (validate.errors ?? []).map(formatIssue) };
      },
    },
  };
}

function formatIssue(error: ErrorObject): string {
  return `${error.instancePath || "(root)"}: ${error.message ?? "is invalid"}`;
}
