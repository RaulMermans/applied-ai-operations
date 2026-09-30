import { z } from "zod";
import { ApprovalIdSchema, NodeIdSchema, RunIdSchema, identifierSchema, isoTimestampSchema, schemaVersionSchema } from "./common.js";
import { PermissionClassesSchema, PrincipalSchema } from "./governance.js";

/** Canonical Approval states. Machine values only — no display strings here. */
export const ApprovalStatusSchema = z.enum(["pending", "approved", "rejected", "expired", "cancelled"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

/**
 * Process-local approval evidence. The digest binds a request without copying
 * its proposed payload. Resolution evidence is never authentication input.
 */
export const ApprovalRecordSchema = z
  .object({
    schemaVersion: schemaVersionSchema(2),
    approvalId: ApprovalIdSchema,
    runId: RunIdSchema,
    nodeId: NodeIdSchema,
    requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    requestedBy: PrincipalSchema,
    requiredApproverRoleIds: z.array(identifierSchema).min(1).refine((ids) => new Set(ids).size === ids.length),
    allowSelfApproval: z.boolean(),
    status: ApprovalStatusSchema,
    requestedAt: isoTimestampSchema,
    resolvedAt: isoTimestampSchema.optional(),
    resolvedBy: PrincipalSchema.optional(),
    permissionClasses: PermissionClassesSchema,
  })
  .strict()
  .superRefine((record, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (record.status === "pending" && (record.resolvedAt !== undefined || record.resolvedBy !== undefined)) issue("status", "pending approval cannot have resolution evidence");
    if (record.status !== "pending" && record.resolvedAt === undefined) issue("resolvedAt", "terminal approval requires resolvedAt");
    if ((record.status === "approved" || record.status === "rejected") && record.resolvedBy?.type !== "user") issue("resolvedBy", "human decision requires a user resolver");
    if (record.resolvedAt !== undefined && Date.parse(record.resolvedAt) < Date.parse(record.requestedAt)) issue("resolvedAt", "resolution cannot predate request");
  });
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;
