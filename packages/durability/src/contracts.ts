import { z } from "zod";
import { AuditCodeSchema, CheckpointIdSchema, NodeIdSchema, NodeKindSchema, PrincipalSchema, RunIdSchema, WorkflowIdSchema, entityVersionSchema, identifierSchema, isoTimestampSchema } from "@aao/contracts";
import { NodeAttemptOutcomeSchema, NodeExecutionRecordSchema, RuntimeExecutionSnapshotSchema, RuntimeFailureSchema } from "@aao/runtime";

/**
 * AAO-owned durable execution contracts (ADR-019). They live here, not in
 * `@aao/contracts`, because the canonical durable checkpoint wraps the
 * Runtime-owned `RuntimeExecutionSnapshot`, and `@aao/contracts` cannot
 * depend on `@aao/runtime`. Every record is JSON-safe, strict, and
 * validated on load; nothing here is a class, function, or credential.
 */

/** Hard bound on crash replays of one ambiguous attempt: replay once, then fail closed. */
export const MAX_RECOVERY_REPLAYS = 1;

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

/** Persistent Run identity, written once with checkpoint 0. Lifecycle status lives only in checkpoints (`RunRecord.status`). */
export const RunManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: RunIdSchema,
    workflowId: WorkflowIdSchema,
    workflowVersion: entityVersionSchema,
    planFingerprint: sha256Hex,
    createdAt: isoTimestampSchema,
  })
  .strict();
export type RunManifest = z.infer<typeof RunManifestSchema>;

/**
 * The single canonical durable execution checkpoint: proof that one safe
 * Runtime boundary was durably stored. It wraps — never redefines — the
 * Runtime's `RuntimeExecutionSnapshot` and execution history. Immutable
 * once written; a later boundary is sequence N + 1.
 */
export const DurableCheckpointSchema = z
  .object({
    schemaVersion: z.literal(1),
    checkpointId: CheckpointIdSchema,
    sequence: z.number().int().nonnegative(),
    runId: RunIdSchema,
    workflowId: WorkflowIdSchema,
    workflowVersion: entityVersionSchema,
    planFingerprint: sha256Hex,
    createdAt: isoTimestampSchema,
    executionSnapshot: RuntimeExecutionSnapshotSchema,
    executionHistory: z.array(NodeExecutionRecordSchema),
    /** Bounded terminal-failure evidence on a FAILED/CANCELLED boundary. */
    failure: RuntimeFailureSchema.optional(),
    /** Evidence of the Governance configuration in force at an approval wait. Never authority. */
    governanceFingerprint: sha256Hex.optional(),
  })
  .strict()
  .superRefine((checkpoint, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    const { run, stateSnapshot } = checkpoint.executionSnapshot;
    if (checkpoint.checkpointId !== checkpointIdFor(checkpoint.sequence)) issue("checkpointId must match sequence");
    if (run.runId !== checkpoint.runId || stateSnapshot.runId !== checkpoint.runId) issue("snapshot run identity must match checkpoint runId");
    if (run.workflowId !== checkpoint.workflowId || run.workflowVersion !== checkpoint.workflowVersion) issue("snapshot workflow identity must match checkpoint");
  });
export type DurableCheckpoint = z.infer<typeof DurableCheckpointSchema>;

export function checkpointIdFor(sequence: number): string {
  return `checkpoint.${String(sequence).padStart(6, "0")}`;
}

/**
 * One executor attempt's write-ahead record. `STARTED` means intent is
 * durable and the outcome is unknown; `OUTCOME_RECORDED` means a
 * Runtime-validated outcome is durable. It is execution-correctness state,
 * not business state and not a trace.
 */
export const DurableOperationSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationId: identifierSchema,
    runId: RunIdSchema,
    nodeId: NodeIdSchema,
    kind: NodeKindSchema,
    step: z.number().int().min(1),
    stateRevision: z.number().int().nonnegative(),
    attempt: z.number().int().min(1),
    maxAttempts: z.number().int().min(1),
    recoveryReplayCount: z.number().int().min(0).max(MAX_RECOVERY_REPLAYS),
    status: z.enum(["STARTED", "OUTCOME_RECORDED"]),
    startedAt: isoTimestampSchema,
    completedAt: isoTimestampSchema.optional(),
    outcome: NodeAttemptOutcomeSchema.optional(),
  })
  .strict()
  .superRefine((operation, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (operation.operationId !== operationIdFor(operation.step, operation.attempt)) issue("operationId must match step and attempt");
    if (operation.attempt > operation.maxAttempts) issue("attempt cannot exceed maxAttempts");
    if ((operation.status === "OUTCOME_RECORDED") !== (operation.outcome !== undefined && operation.completedAt !== undefined)) issue("an outcome and completedAt are present exactly when status is OUTCOME_RECORDED");
  });
export type DurableOperation = z.infer<typeof DurableOperationSchema>;

export function operationIdFor(step: number, attempt: number): string {
  return `op.s${step}.a${attempt}`;
}

/**
 * A durable, idempotent host cancellation request. Applied at the next safe
 * boundary; it never reverses completed work. `requestedBy` is the
 * host-attested principal accountable for the request (ADR-021) and
 * `reasonCode` an optional bounded code — never free text. Records written
 * before Sprint 16 carry no attribution and are never given a fabricated one.
 */
export const CancellationRecordSchema = z.object({ schemaVersion: z.literal(1), runId: RunIdSchema, requestedAt: isoTimestampSchema, requestedBy: PrincipalSchema.optional(), reasonCode: AuditCodeSchema.optional() }).strict();
export type CancellationRecord = z.infer<typeof CancellationRecordSchema>;

export const DURABILITY_FAILURE_CODES = [
  "DURABLE_RUN_ALREADY_EXISTS",
  "DURABLE_RUN_NOT_FOUND",
  "DURABLE_RUN_BUSY",
  "DURABILITY_INVALID_INPUT",
  "DURABILITY_PLAN_MISMATCH",
  "DURABILITY_CORRUPT_STATE",
  "DURABILITY_CONFLICT",
  "DURABILITY_IO_FAILED",
  "DURABILITY_UNSAFE_REPLAY",
  "DURABILITY_RECOVERY_REPLAY_EXHAUSTED",
] as const;
export type DurabilityFailureCode = (typeof DURABILITY_FAILURE_CODES)[number];

/**
 * A redacted durability failure. The message is a fixed, code-derived
 * string: no filesystem path, OS error text, stack, or stored content ever
 * leaves the store through it.
 */
export class DurabilityError extends Error {
  constructor(readonly code: DurabilityFailureCode) {
    super(code);
    this.name = "DurabilityError";
  }
}

export function durabilityCodeOf(error: unknown): DurabilityFailureCode {
  return error instanceof DurabilityError ? error.code : "DURABILITY_IO_FAILED";
}
