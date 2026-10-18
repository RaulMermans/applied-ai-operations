import { z } from "zod";
import { OPERATIONAL_REQUEST_LIMITS as L } from "./limits.js";

export const SUPPORTED_OPERATIONS = ["account.update_display_name"] as const;
export type SupportedOperation = (typeof SUPPORTED_OPERATIONS)[number];

export const REQUEST_ID_PATTERN = /^[a-zA-Z0-9._:-]{3,64}$/;
export const ACCOUNT_ID_PATTERN = /^[A-Z0-9_-]{3,32}$/;

// --- Operational Request Contract (Intake) ---

export const OperationalRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: z.string().regex(REQUEST_ID_PATTERN),
    instruction: z.string().min(L.minInstructionLength).max(L.maxInstructionLength),
    accountContext: z
      .object({
        accountId: z.string().regex(ACCOUNT_ID_PATTERN),
        currentDisplayName: z.string().min(L.minDisplayNameLength).max(L.maxDisplayNameLength),
      })
      .strict(),
  })
  .strict();

export type OperationalRequest = z.infer<typeof OperationalRequestSchema>;
export type OperationalRequestInput = OperationalRequest;

// --- Model Proposal Contract ---

export const OperationalActionProposalSchema = z
  .object({
    operation: z.literal("account.update_display_name"),
    target: z
      .object({
        accountId: z.string().regex(ACCOUNT_ID_PATTERN),
      })
      .strict(),
    changes: z
      .object({
        displayName: z.string().min(L.minDisplayNameLength).max(L.maxDisplayNameLength),
      })
      .strict(),
    justification: z.string().min(L.minJustificationLength).max(L.maxJustificationLength),
  })
  .strict();

export type OperationalActionProposal = z.infer<typeof OperationalActionProposalSchema>;

// --- Approval Subject Contract (Draft-Only) ---

export const OperationalApprovalSubjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: z.string().regex(REQUEST_ID_PATTERN),
    operation: z.literal("account.update_display_name"),
    accountId: z.string().regex(ACCOUNT_ID_PATTERN),
    proposedChanges: z
      .object({
        displayName: z.string().min(L.minDisplayNameLength).max(L.maxDisplayNameLength),
      })
      .strict(),
    executionMode: z.literal("draft_only"),
  })
  .strict();

export type OperationalApprovalSubject = z.infer<typeof OperationalApprovalSubjectSchema>;

// --- Local Approved Change Draft Contract ---

export const OperationalChangeDraftSchema = z
  .object({
    schemaVersion: z.literal(1),
    draftId: z.string().min(1).max(L.maxDraftIdLength),
    requestId: z.string().regex(REQUEST_ID_PATTERN),
    operation: z.literal("account.update_display_name"),
    accountId: z.string().regex(ACCOUNT_ID_PATTERN),
    proposedChanges: z
      .object({
        displayName: z.string().min(L.minDisplayNameLength).max(L.maxDisplayNameLength),
      })
      .strict(),
    approvalId: z.string().min(1).max(128),
    status: z.literal("approved_draft"),
    externalExecution: z.literal("not_executed"),
  })
  .strict();

export type OperationalChangeDraft = z.infer<typeof OperationalChangeDraftSchema>;

// --- Final Operational Result Contract ---

export const OperationalRequestResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: z.string().regex(REQUEST_ID_PATTERN),
    operation: z.literal("account.update_display_name"),
    accountId: z.string().regex(ACCOUNT_ID_PATTERN),
    draftId: z.string().min(1).max(L.maxDraftIdLength),
    approvalId: z.string().min(1).max(128),
    draftStatus: z.literal("approved_draft"),
    externalExecution: z.literal("not_executed"),
    outcome: z.literal("completed"),
    renderedMarkdown: z.string().min(1),
  })
  .strict();

export type OperationalRequestResult = z.infer<typeof OperationalRequestResultSchema>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateOperationalRequest(input: unknown): { ok: true; value: OperationalRequest } | { ok: false; code: string; message: string } {
  const result = OperationalRequestSchema.safeParse(input);
  if (!result.success) {
    return {
      ok: false,
      code: "INVALID_OPERATIONAL_REQUEST",
      message: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join(", "),
    };
  }
  return { ok: true, value: result.data };
}
