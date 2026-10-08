import { z } from "zod";
import { FailureCategorySchema, JsonObjectSchema, JsonValueSchema, NodeIdSchema, NodeKindSchema, RunIdSchema, identifierSchema } from "@aao/contracts";
import type { CompiledWorkflowPlan } from "@aao/workflow-dsl";
import { captureExecutionSnapshot, validateSnapshotAgainstPlan } from "./execution-snapshot.js";
import { isJsonSafe } from "./json-safety.js";
import { NodeExecutorFailureSchema } from "./node-result-validation.js";
import { RUNTIME_FAILURE_CODES, type NodeAttemptOutcome, type NodeExecutionRecord, type RuntimeExecutionState, type RuntimeFailure } from "./types.js";

/**
 * Runtime-owned schemas for the execution data a durability host persists
 * alongside a `RuntimeExecutionSnapshot` (ADR-019). The Runtime owns these
 * shapes so a host can validate anything it loads against the same
 * definitions the Runtime produces; the host never invents its own.
 */

const RuntimeFailureCodeSchema = z.enum(RUNTIME_FAILURE_CODES);
const boundedMessage = z.string().max(2048);

export const NodeAttemptFailureSchema = z.object({ attempt: z.number().int().min(1), category: FailureCategorySchema, causeCode: z.string().min(1).max(64) }).strict();

export const NodeExecutionRecordSchema = z
  .object({
    nodeId: NodeIdSchema,
    kind: NodeKindSchema,
    step: z.number().int().min(1),
    status: z.enum(["SUCCEEDED", "FAILED"]),
    output: JsonValueSchema.optional(),
    stateRevisionBefore: z.number().int().nonnegative(),
    stateRevisionAfter: z.number().int().nonnegative(),
    attemptCount: z.number().int().min(1),
    attemptFailures: z.array(NodeAttemptFailureSchema).optional(),
  })
  .strict();

/** A validated attempt outcome as a durability host may persist it. Raw executor responses never match. */
export const NodeAttemptOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("success"), statePatch: JsonObjectSchema.optional(), output: JsonValueSchema.optional() }).strict(),
  z.object({ kind: z.literal("wait"), wait: z.object({ kind: z.literal("approval"), referenceId: identifierSchema, requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict() }).strict(),
  z.object({ kind: z.literal("failure"), code: RuntimeFailureCodeSchema, category: FailureCategorySchema, message: boundedMessage, executorFailure: NodeExecutorFailureSchema.optional() }).strict(),
]);

/** Bounded terminal-failure evidence. Mirrors `RuntimeFailure`; no stack or raw thrown value can match it. */
export const RuntimeFailureSchema = z
  .object({
    code: RuntimeFailureCodeSchema,
    message: boundedMessage,
    nodeId: NodeIdSchema.optional(),
    step: z.number().int().nonnegative().optional(),
    details: JsonObjectSchema.optional(),
    executorFailure: NodeExecutorFailureSchema.optional(),
    category: FailureCategorySchema.optional(),
    retryable: z.boolean().optional(),
    attempt: z.number().int().min(1).optional(),
    maxAttempts: z.number().int().min(1).optional(),
    causeCode: z.string().min(1).max(64).optional(),
  })
  .strict();

export function parseNodeAttemptOutcome(raw: unknown): NodeAttemptOutcome | undefined {
  if (!isJsonSafe(raw)) return undefined;
  const parsed = NodeAttemptOutcomeSchema.safeParse(raw);
  return parsed.success ? (parsed.data as NodeAttemptOutcome) : undefined;
}

export function parseExecutionHistory(raw: unknown): NodeExecutionRecord[] | undefined {
  if (!isJsonSafe(raw)) return undefined;
  const parsed = z.array(NodeExecutionRecordSchema).safeParse(raw);
  return parsed.success ? (parsed.data as NodeExecutionRecord[]) : undefined;
}

export function parseRuntimeFailure(raw: unknown): RuntimeFailure | undefined {
  if (!isJsonSafe(raw)) return undefined;
  const parsed = RuntimeFailureSchema.safeParse(raw);
  return parsed.success ? (parsed.data as RuntimeFailure) : undefined;
}

/**
 * Verifies a whole `RuntimeExecutionState` — not just its snapshot — is a
 * coherent safe boundary of `plan`: the snapshot rules, plus history that
 * references plan nodes in increasing steps, agrees with Node lifecycle,
 * chains state revisions without gaps, and ends at the current revision.
 * Used before resuming an execution loaded from outside the Runtime.
 */
export function validateExecutionAgainstPlan(execution: RuntimeExecutionState, plan: CompiledWorkflowPlan): RuntimeFailure | undefined {
  const invalid = (message: string): RuntimeFailure => ({ code: "INVALID_EXECUTION_SNAPSHOT", message });
  if (!RunIdSchema.safeParse(execution?.run?.runId).success || execution.state?.runId !== execution.run.runId) return invalid("Execution run and state identity disagree.");
  let snapshot;
  try {
    snapshot = captureExecutionSnapshot(execution, execution.run.updatedAt);
  } catch {
    return invalid("Execution is not a safe execution boundary.");
  }
  const compatibility = validateSnapshotAgainstPlan(snapshot, plan);
  if (compatibility) return compatibility;
  const history = parseExecutionHistory(execution.history);
  if (!history) return invalid("Execution history does not match NodeExecutionRecordSchema.");
  let previousStep = 0;
  let previousRevision: number | undefined;
  for (const record of history) {
    const node = plan.nodesById[record.nodeId];
    if (!node || node.kind !== record.kind) return invalid(`History record for "${record.nodeId}" does not match the plan.`);
    if (record.step <= previousStep || record.step > execution.step) return invalid("History steps must increase and not exceed the execution step.");
    const status = execution.nodeStatusesById[record.nodeId];
    if (record.status === "SUCCEEDED" ? status !== "SUCCEEDED" : status !== "FAILED" && status !== "CANCELLED") return invalid(`History record for "${record.nodeId}" disagrees with Node lifecycle.`);
    if (record.stateRevisionAfter < record.stateRevisionBefore || record.stateRevisionAfter - record.stateRevisionBefore > 1) return invalid("History state revisions must advance by at most one per record.");
    if (record.status === "FAILED" && record.stateRevisionAfter !== record.stateRevisionBefore) return invalid("A failed history record cannot advance state.");
    if (previousRevision !== undefined && record.stateRevisionBefore !== previousRevision) return invalid("History state revisions are not contiguous.");
    previousStep = record.step;
    previousRevision = record.stateRevisionAfter;
  }
  if (previousRevision !== undefined && previousRevision !== execution.state.revision) return invalid("History does not end at the current state revision.");
  // A CANCELLED Node has a record only if it was a cancelled approval wait; SUCCEEDED/FAILED Nodes always have exactly one.
  const recorded = new Set(history.map((record) => record.nodeId));
  const finished = Object.entries(execution.nodeStatusesById).filter(([, status]) => status === "SUCCEEDED" || status === "FAILED");
  if (recorded.size !== history.length || finished.some(([nodeId]) => !recorded.has(nodeId))) return invalid("Every finished Node must have exactly one history record.");
  return undefined;
}
