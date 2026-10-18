import { createHash } from "node:crypto";
import { approvalIdForFingerprint, fingerprintApprovalSubject } from "@aao/approval";
import type { ApprovalRecord } from "@aao/contracts";
import { defineTool, type AAOApprovals, type ToolDefinition, type ToolHandler } from "@aao/framework";
import type { OperationalApprovalSubject, OperationalChangeDraft } from "./contracts.js";
import type { OperationalDraftRepository } from "./repository.js";

export const CREATE_CHANGE_DRAFT_TOOL_REF = Object.freeze({
  id: "operations.create_change_draft",
  version: "1.0.0",
});

export interface CreateChangeDraftToolInput {
  requestId: string;
  accountId: string;
  operation: "account.update_display_name";
  proposedChanges: {
    displayName: string;
  };
  approvalBinding: {
    approvalId: string;
    requestFingerprint: string;
    runId?: string;
  };
}

export interface CreateChangeDraftToolOutput {
  [key: string]: string;
  draftId: string;
  status: "approved_draft";
  externalExecution: "not_executed";
}

export interface OperationalApprovalVerifier {
  verifyApproval(params: {
    approvalId: string;
    requestFingerprint: string;
    runId?: string;
    draftPayload: {
      requestId: string;
      accountId: string;
      operation: string;
      proposedChanges: {
        displayName: string;
      };
    };
  }): { ok: true; approvalRecord: ApprovalRecord } | { ok: false; code: string };
}

/**
 * Creates a canonical approval verifier that verifies approval records
 * against the trusted Approval Engine.
 */
export function createOperationalApprovalVerifier(options: {
  getApproval: (approvalId: string) => ApprovalRecord | undefined;
  expectedRunId?: string;
}): OperationalApprovalVerifier {
  const consumedApprovals = new Set<string>();

  return {
    verifyApproval(params) {
      const record = options.getApproval(params.approvalId);
      if (!record) {
        return { ok: false, code: "APPROVAL_NOT_FOUND" };
      }

      if (record.status === "pending") {
        return { ok: false, code: "APPROVAL_STILL_PENDING" };
      }
      if (record.status === "rejected") {
        return { ok: false, code: "APPROVAL_REJECTED" };
      }
      if (record.status !== "approved") {
        return { ok: false, code: "INVALID_APPROVAL_STATUS" };
      }

      if (record.nodeId !== "require_approval") {
        return { ok: false, code: "INVALID_APPROVAL_CONTEXT" };
      }

      const expectedRunId = params.runId ?? options.expectedRunId;
      if (expectedRunId !== undefined && record.runId !== expectedRunId) {
        return { ok: false, code: "INVALID_APPROVAL_CONTEXT" };
      }

      if (record.approvalId !== params.approvalId) {
        return { ok: false, code: "INVALID_APPROVAL_CONTEXT" };
      }

      if (record.requestFingerprint !== params.requestFingerprint) {
        return { ok: false, code: "APPROVAL_REQUEST_MISMATCH" };
      }

      const expectedApprovalId = approvalIdForFingerprint(
        record.runId,
        record.nodeId,
        record.requestFingerprint
      );
      if (record.approvalId !== expectedApprovalId) {
        return { ok: false, code: "INVALID_APPROVAL_CONTEXT" };
      }

      const expectedSubject: OperationalApprovalSubject = {
        schemaVersion: 1,
        requestId: params.draftPayload.requestId,
        operation: "account.update_display_name",
        accountId: params.draftPayload.accountId,
        proposedChanges: {
          displayName: params.draftPayload.proposedChanges.displayName,
        },
        executionMode: "draft_only",
      };

      let matchesPayload = false;
      for (let rev = 0; rev <= 32; rev++) {
        try {
          const fp = fingerprintApprovalSubject(record.runId, record.nodeId, rev, expectedSubject);
          if (fp === record.requestFingerprint) {
            matchesPayload = true;
            break;
          }
        } catch {
          // Ignore context errors during revision probe
        }
      }

      if (!matchesPayload) {
        return { ok: false, code: "APPROVAL_REQUEST_MISMATCH" };
      }

      if (consumedApprovals.has(record.approvalId)) {
        return { ok: false, code: "APPROVAL_ALREADY_CONSUMED" };
      }

      consumedApprovals.add(record.approvalId);
      return { ok: true, approvalRecord: record };
    },
  };
}

export interface CreateOperationalDraftToolOptions {
  repository: OperationalDraftRepository;
  approvalVerifier?: OperationalApprovalVerifier;
  approvals?: AAOApprovals;
}

/**
 * Creates the canonical `operations.create_change_draft@1.0.0` Tool.
 *
 * Permission: `write_draft`.
 * Idempotency: `execution_id`.
 * Creates a structured change draft in the host-owned repository only after
 * verifying a valid canonical human approval for the exact operation and payload.
 * Never modifies an external account or business system.
 */
export function createOperationalDraftTool(options: CreateOperationalDraftToolOptions): ToolDefinition {
  const verifier: OperationalApprovalVerifier | undefined =
    options.approvalVerifier ??
    (options.approvals
      ? createOperationalApprovalVerifier({ getApproval: (id) => options.approvals!.get(id) })
      : undefined);

  const handler: ToolHandler = {
    async execute(context) {
      const input = context.input as unknown as CreateChangeDraftToolInput;
      const draftId = `draft.${createHash("sha256")
        .update(`${input.requestId}:${input.accountId}:${input.proposedChanges.displayName}`)
        .digest("hex")
        .slice(0, 16)}`;

      // 1. Idempotency: check if this executionId already ran
      const existingByExec = options.repository.getDraftByExecutionId(context.toolExecutionId);
      if (existingByExec) {
        if (
          existingByExec.draftId === draftId &&
          existingByExec.approvalId === input.approvalBinding?.approvalId &&
          existingByExec.requestId === input.requestId &&
          existingByExec.accountId === input.accountId &&
          existingByExec.proposedChanges.displayName === input.proposedChanges.displayName
        ) {
          return {
            ok: true,
            output: {
              draftId: existingByExec.draftId,
              status: existingByExec.status,
              externalExecution: existingByExec.externalExecution,
            },
          };
        }
        return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
      }

      // 2. Trusted approval verification
      if (!verifier) {
        return { ok: false, code: "APPROVAL_VERIFICATION_FAILED" };
      }

      const verification = verifier.verifyApproval({
        approvalId: input.approvalBinding?.approvalId,
        requestFingerprint: input.approvalBinding?.requestFingerprint,
        runId: input.approvalBinding?.runId,
        draftPayload: {
          requestId: input.requestId,
          accountId: input.accountId,
          operation: input.operation,
          proposedChanges: input.proposedChanges,
        },
      });

      if (!verification.ok) {
        return { ok: false, code: verification.code };
      }

      // 3. Draft construction & host repository persistence
      const draft: OperationalChangeDraft = {
        schemaVersion: 1,
        draftId,
        requestId: input.requestId,
        operation: input.operation,
        accountId: input.accountId,
        proposedChanges: {
          displayName: input.proposedChanges.displayName,
        },
        approvalId: verification.approvalRecord.approvalId,
        status: "approved_draft",
        externalExecution: "not_executed",
      };

      const result = await options.repository.saveDraft(context.toolExecutionId, draft);
      if (!result.ok) {
        return { ok: false, code: result.code };
      }

      const output: CreateChangeDraftToolOutput = {
        draftId: result.draft.draftId,
        status: result.draft.status,
        externalExecution: result.draft.externalExecution,
      };

      return { ok: true, output };
    },
  };

  return defineTool({
    spec: {
      schemaVersion: 1,
      id: CREATE_CHANGE_DRAFT_TOOL_REF.id,
      version: CREATE_CHANGE_DRAFT_TOOL_REF.version,
      name: "Create operational change draft",
      description: "Creates an approved local operational draft for an account display name update.",
      permissionClasses: ["write_draft"],
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string" },
          accountId: { type: "string" },
          operation: { type: "string", enum: ["account.update_display_name"] },
          proposedChanges: {
            type: "object",
            properties: {
              displayName: { type: "string" },
            },
            required: ["displayName"],
            additionalProperties: false,
          },
          approvalBinding: {
            type: "object",
            properties: {
              approvalId: { type: "string" },
              requestFingerprint: { type: "string" },
              runId: { type: "string" },
            },
            required: ["approvalId", "requestFingerprint"],
            additionalProperties: false,
          },
        },
        required: ["requestId", "accountId", "operation", "proposedChanges", "approvalBinding"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          draftId: { type: "string" },
          status: { type: "string", enum: ["approved_draft"] },
          externalExecution: { type: "string", enum: ["not_executed"] },
        },
        required: ["draftId", "status", "externalExecution"],
        additionalProperties: false,
      },
    },
    handler,
    retrySafety: "unsafe",
    idempotency: "execution_id",
  });
}
