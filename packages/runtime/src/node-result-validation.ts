import { z } from "zod";
import { FailureCategorySchema, type JsonObject, type JsonValue } from "@aao/contracts";
import { isJsonSafe } from "./json-safety.js";
import type { NodeExecutionResult, NodeExecutorFailure } from "./types.js";

/**
 * Validates the *shape* a successful executor result must have before any
 * JSON-safety check runs: a plain object with `ok: true` and only the two
 * known optional keys. `z.unknown()` is used for the values here
 * deliberately — the deeper JSON-safety check below (`isJsonSafe`) is
 * stricter than Zod's own record/array inference can be (see
 * `json-safety.ts` for why), so this schema only needs to reject unexpected
 * top-level shape (not an object at all, unknown keys) before that deeper
 * check runs.
 */
const NodeExecutionSuccessShapeSchema = z
  .object({
    ok: z.literal(true),
    statePatch: z.unknown().optional(),
    output: z.unknown().optional(),
  })
  .strict();

const NodeExecutionWaitShapeSchema = z.object({
  ok: z.literal(true),
  wait: z.object({ kind: z.literal("approval"), referenceId: z.string().regex(/^[a-zA-Z0-9]+(?:[._:-][a-zA-Z0-9]+)*$/).max(256), requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
}).strict();

/**
 * The bounded executor-failure vocabulary. `namespace` is a short lowercase
 * subsystem name (`model`, `agent`); `code` is an UPPER_SNAKE_CASE failure
 * code. Both are length-bounded, and the object is strict: a message, stack,
 * exception, provider payload, or any nested metadata is rejected rather
 * than carried into a Runtime failure.
 */
const EXECUTOR_FAILURE_NAMESPACE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const EXECUTOR_FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

const NodeExecutorFailureSchema = z
  .object({
    namespace: z.string().regex(EXECUTOR_FAILURE_NAMESPACE_PATTERN),
    code: z.string().regex(EXECUTOR_FAILURE_CODE_PATTERN),
    category: FailureCategorySchema.optional(),
  })
  .strict();

const NodeExecutionFailureShapeSchema = z
  .object({
    ok: z.literal(false),
    failure: NodeExecutorFailureSchema,
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
 * instances, class instances, non-JSON output, any unexpected key, a result
 * without an explicit `ok` discriminant, and any executor failure outside
 * the bounded `{ namespace, code }` vocabulary.
 *
 * A *valid* executor failure validates successfully (`{ ok: true, result:
 * { ok: false, failure } }`): the result itself is well-formed, and the
 * Runtime then decides what an executor failure means for the Node and Run.
 */
export function validateNodeExecutionResult(raw: unknown): NodeResultValidation {
  if (raw !== null && typeof raw === "object" && "wait" in raw) {
    const waitShape = NodeExecutionWaitShapeSchema.safeParse(raw);
    if (!waitShape.success) return { ok: false, code: "INVALID_NODE_RESULT", message: "wait result must carry only a bounded approval reference and request fingerprint." };
    return { ok: true, result: waitShape.data };
  }
  if (raw !== null && typeof raw === "object" && (raw as { ok?: unknown }).ok === false) {
    const failureShape = NodeExecutionFailureShapeSchema.safeParse(raw);
    if (!failureShape.success) {
      return { ok: false, code: "INVALID_NODE_RESULT", message: "Node executor failure must be exactly { ok: false, failure: { namespace, code } } with a bounded namespace and code." };
    }
    const { namespace, code, category } = failureShape.data.failure;
    const failure: NodeExecutorFailure = { namespace, code, ...(category !== undefined ? { category } : {}) };
    return { ok: true, result: { ok: false, failure } };
  }

  const shape = NodeExecutionSuccessShapeSchema.safeParse(raw);
  if (!shape.success) {
    return { ok: false, code: "INVALID_NODE_RESULT", message: "Node executor result must be a plain object with ok: true and only optional statePatch/output fields." };
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

  const result: NodeExecutionResult & { ok: true } = { ok: true };
  if (statePatch !== undefined) result.statePatch = statePatch as JsonObject;
  if (output !== undefined) result.output = output as JsonValue;
  return { ok: true, result };
}

function isPlainJsonObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return isJsonSafe(value);
}
