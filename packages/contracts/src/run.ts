import { z } from "zod";
import { NodeIdSchema, RunIdSchema, WorkflowIdSchema, entityVersionSchema, isoTimestampSchema, schemaVersionSchema } from "./common.js";

/**
 * Canonical Run statuses, frozen by `docs/architecture/runtime-lifecycle.md`.
 * A run represents one whole workflow execution. Legal transitions between
 * these statuses are documented there; this sprint defines the contract only,
 * not the state machine that enforces transitions.
 */
export const RunStatusSchema = z.enum([
  "CREATED",
  "VALIDATING",
  "QUEUED",
  "RUNNING",
  "WAITING_FOR_APPROVAL",
  "RETRYING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * Canonical Node statuses, frozen by `docs/architecture/runtime-lifecycle.md`.
 * A node represents one unit of work inside a run. Kept separate from
 * `RunStatus` — run and node lifecycle are distinct concerns.
 */
export const NodeStatusSchema = z.enum([
  "PENDING",
  "READY",
  "RUNNING",
  "WAITING",
  "SUCCEEDED",
  "FAILED",
  "SKIPPED",
  "CANCELLED",
]);
export type NodeStatus = z.infer<typeof NodeStatusSchema>;

/**
 * A minimal Run record: identity and lifecycle only. It carries no
 * database-specific fields (no row id, no storage metadata) and implements no
 * transition logic — that belongs to the future runtime.
 */
export const RunRecordSchema = z
  .object({
    schemaVersion: schemaVersionSchema(1),
    runId: RunIdSchema,
    workflowId: WorkflowIdSchema,
    workflowVersion: entityVersionSchema,
    status: RunStatusSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    currentNodeId: NodeIdSchema.optional(),
  })
  .strict();
export type RunRecord = z.infer<typeof RunRecordSchema>;
