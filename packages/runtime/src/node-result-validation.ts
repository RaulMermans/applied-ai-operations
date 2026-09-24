import { z } from "zod";
import type { JsonObject, JsonValue } from "@aao/contracts";
import { isJsonSafe } from "./json-safety.js";
import type { NodeExecutionResult } from "./types.js";

/**
 * Validates the *shape* an executor result must have before any JSON-safety
 * check runs: a plain object with only the two known keys. `z.unknown()` is
 * used for the values here deliberately — the deeper JSON-safety check below
 * (`isJsonSafe`) is stricter than Zod's own record/array inference can be
 * (see `json-safety.ts` for why), so this schema only needs to reject
 * unexpected top-level shape (not an object at all, unknown keys) before
 * that deeper check runs.
 */
const NodeExecutionResultShapeSchema = z
  .object({
    statePatch: z.unknown().optional(),
    output: z.unknown().optional(),
  })
  .strict();

export type NodeResultValidation =
  | { ok: true; result: NodeExecutionResult }
  | { ok: false; code: "INVALID_NODE_RESULT" | "INVALID_STATE_PATCH"; message: string };

/**
 * Validates raw executor output at the Runtime boundary. Executors are
 * TypeScript-typed to return `NodeExecutionResult`, but the boundary cannot
 * trust that at runtime: `as any`, a JavaScript caller, or an implementation
 * bug can all produce a malformed value. Rejects function values, `Date`
 * instances, class instances, non-JSON output, and any unexpected key.
 */
export function validateNodeExecutionResult(raw: unknown): NodeResultValidation {
  const shape = NodeExecutionResultShapeSchema.safeParse(raw);
  if (!shape.success) {
    return { ok: false, code: "INVALID_NODE_RESULT", message: "Node executor result must be a plain object with only optional statePatch/output fields." };
  }

  const { statePatch, output } = shape.data;

  if (statePatch !== undefined) {
    if (!isPlainJsonObject(statePatch)) {
      return { ok: false, code: "INVALID_STATE_PATCH", message: "statePatch must be a JSON-safe plain object." };
    }
  }

  if (output !== undefined && !isJsonSafe(output)) {
    return { ok: false, code: "INVALID_NODE_RESULT", message: "output must be a JSON-safe value." };
  }

  const result: NodeExecutionResult = {};
  if (statePatch !== undefined) result.statePatch = statePatch as JsonObject;
  if (output !== undefined) result.output = output as JsonValue;
  return { ok: true, result };
}

function isPlainJsonObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return isJsonSafe(value);
}
