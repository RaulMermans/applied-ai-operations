import { z } from "zod";
import { ApprovalIdSchema, NodeIdSchema, RunIdSchema, isoTimestampSchema, schemaVersionSchema } from "./common.js";
import { PermissionClassesSchema } from "./governance.js";

/** Canonical Approval states. Machine values only — no display strings here. */
export const ApprovalStatusSchema = z.enum(["pending", "approved", "rejected", "expired", "cancelled"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

/**
 * The smallest useful Approval domain model. `schemaVersion` is included for
 * consistency with the other persisted governance/lifecycle records (Run,
 * Checkpoint) even though the sprint's field list for Approval did not spell
 * it out explicitly — see `docs/architecture/domain-contracts.md`.
 *
 * This sprint implements no approval persistence, UI, notification,
 * waitpoint execution, or expiry scheduler, and the contract must never carry
 * raw secrets or unnecessary sensitive tool arguments.
 */
export const ApprovalRecordSchema = z
  .object({
    schemaVersion: schemaVersionSchema(1),
    approvalId: ApprovalIdSchema,
    runId: RunIdSchema,
    nodeId: NodeIdSchema.optional(),
    status: ApprovalStatusSchema,
    requestedAt: isoTimestampSchema,
    resolvedAt: isoTimestampSchema.optional(),
    resolvedBy: z.string().min(1).optional(),
    permissionClasses: PermissionClassesSchema,
  })
  .strict();
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;
