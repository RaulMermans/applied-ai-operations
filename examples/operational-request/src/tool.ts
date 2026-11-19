import { createHash } from "node:crypto";
import { approvalIdForFingerprint, fingerprintApprovalSubject } from "@aao/approval";
import type { ApprovalRecord } from "@aao/contracts";
import { defineTool, type AAOApprovals, type ToolDefinition, type ToolHandler } from "@aao/framework";
import { deriveToolExecutionId } from "@aao/tool-runtime";
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
    toolExecutionId: string;
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

  attestExecutionOrigin(runId: string, toolExecutionId: string): void;
  isOriginAttested(runId: string, toolExecutionId: string): boolean;

  commitApproval(approvalId: string, toolExecutionId: string): void;
  releaseApproval(approvalId: string, toolExecutionId: string): void;
  getConsumptionState(approvalId: string): "AVAILABLE" | "IN_FLIGHT" | "COMMITTED" | undefined;
}

export interface CreateOperationalApprovalVerifierOptions {
  getApproval: (approvalId: string) => ApprovalRecord | undefined;
  expectedRunId?: string;
  isOriginAttested?: (params: { runId: string; toolExecutionId: string }) => boolean;
  attestOrigin?: (params: { runId: string; toolExecutionId: string }) => void;
  requireOriginAttestation?: boolean;
}

/**
 * Creates a canonical approval verifier that verifies approval records
 * against the trusted Approval Engine, binds execution to canonical Tool
 * execution identity, and manages an atomic, recoverable approval reservation lifecycle.
 */
export function createOperationalApprovalVerifier(
  options: CreateOperationalApprovalVerifierOptions
): OperationalApprovalVerifier {
  type ConsumptionRecord =
    | { state: "IN_FLIGHT"; toolExecutionId: string; timestamp: number }
    | { state: "COMMITTED"; toolExecutionId: string; timestamp: number };

  const consumptionStates = new Map<string, ConsumptionRecord>();
  const attestedOrigins = new Set<string>();

  const originKey = (runId: string, toolExecutionId: string) => `${runId}::${toolExecutionId}`;

  return {
    attestExecutionOrigin(runId: string, toolExecutionId: string) {
      attestedOrigins.add(originKey(runId, toolExecutionId));
      options.attestOrigin?.({ runId, toolExecutionId });
    },

    isOriginAttested(runId: string, toolExecutionId: string) {
      if (options.isOriginAttested) {
        return options.isOriginAttested({ runId, toolExecutionId });
      }
      return attestedOrigins.has(originKey(runId, toolExecutionId));
    },

    commitApproval(approvalId: string, toolExecutionId: string) {
      const current = consumptionStates.get(approvalId);
      if (current && current.toolExecutionId === toolExecutionId) {
        consumptionStates.set(approvalId, {
          state: "COMMITTED",
          toolExecutionId,
          timestamp: Date.now(),
        });
      }
    },

    releaseApproval(approvalId: string, toolExecutionId: string) {
      const current = consumptionStates.get(approvalId);
      if (current && current.state === "IN_FLIGHT" && current.toolExecutionId === toolExecutionId) {
        consumptionStates.delete(approvalId);
      }
    },

    getConsumptionState(approvalId: string) {
      return consumptionStates.get(approvalId)?.state ?? "AVAILABLE";
    },

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

      // Canonical tool execution identity binding:
      // The expected Tool execution ID is deterministically derived from the approved Run ID and the authorized "create_draft" node.
      const expectedToolExecutionId = deriveToolExecutionId(record.runId, "create_draft");
      if (params.toolExecutionId !== expectedToolExecutionId) {
        return { ok: false, code: "INVALID_APPROVAL_CONTEXT" };
      }

      // Untrusted caller-supplied runId must not establish expected run, but if supplied, must match approved run
      if (params.runId !== undefined && record.runId !== params.runId) {
        return { ok: false, code: "INVALID_APPROVAL_CONTEXT" };
      }

      // Configuration-supplied expectedRunId check
      if (options.expectedRunId !== undefined && record.runId !== options.expectedRunId) {
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

      // Trusted host execution origin attestation check
      if (options.requireOriginAttestation !== false) {
        const isAttested = options.isOriginAttested
          ? options.isOriginAttested({ runId: record.runId, toolExecutionId: params.toolExecutionId })
          : attestedOrigins.has(originKey(record.runId, params.toolExecutionId));

        if (!isAttested) {
          return { ok: false, code: "UNTRUSTED_EXECUTION_ORIGIN" };
        }
      }

      // Approval consumption lifecycle check and reservation
      const current = consumptionStates.get(record.approvalId);
      if (current) {
        if (current.state === "COMMITTED") {
          if (current.toolExecutionId === params.toolExecutionId) {
            // Replay under identical execution identity
            return { ok: true, approvalRecord: record };
          }
          return { ok: false, code: "APPROVAL_ALREADY_CONSUMED" };
        }
        if (current.state === "IN_FLIGHT") {
          if (current.toolExecutionId === params.toolExecutionId) {
            // Re-entrant / retry under same execution identity
            return { ok: true, approvalRecord: record };
          }
          return { ok: false, code: "APPROVAL_ALREADY_CONSUMED" };
        }
      }

      // Reserve approved operation (AVAILABLE -> IN_FLIGHT)
      consumptionStates.set(record.approvalId, {
        state: "IN_FLIGHT",
        toolExecutionId: params.toolExecutionId,
        timestamp: Date.now(),
      });

      return { ok: true, approvalRecord: record };
    },
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function reconcileUncertainCommit(
  repository: OperationalDraftRepository,
  toolExecutionId: string,
  expectedDraft: OperationalChangeDraft
): { ok: true; draft: OperationalChangeDraft } | { ok: false; code: "NO_COMMIT_PROVEN" | "IDEMPOTENCY_CONFLICT" | "PERSISTENCE_INDETERMINATE" } {
  let existingByExec: OperationalChangeDraft | undefined;
  let existingById: OperationalChangeDraft | undefined;
  try {
    existingByExec = repository.getDraftByExecutionId(toolExecutionId);
    existingById = repository.getDraft(expectedDraft.draftId);
  } catch {
    return { ok: false, code: "PERSISTENCE_INDETERMINATE" };
  }

  if (existingByExec) {
    if (deepEqual(existingByExec, expectedDraft)) {
      return { ok: true, draft: existingByExec };
    }
    return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
  }

  if (existingById) {
    if (deepEqual(existingById, expectedDraft)) {
      return { ok: true, draft: existingById };
    }
    return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
  }

  return { ok: false, code: "NO_COMMIT_PROVEN" };
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

      // 2. Trusted approval verification & reservation
      if (!verifier) {
        return { ok: false, code: "APPROVAL_VERIFICATION_FAILED" };
      }

      const verification = verifier.verifyApproval({
        approvalId: input.approvalBinding?.approvalId,
        requestFingerprint: input.approvalBinding?.requestFingerprint,
        toolExecutionId: context.toolExecutionId,
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

      let saveResult: { ok: true; draft: OperationalChangeDraft } | { ok: false; code: "IDEMPOTENCY_CONFLICT" };
      try {
        saveResult = await options.repository.saveDraft(context.toolExecutionId, draft);
      } catch {
        // Reconcile uncertain commit on thrown exception
        const reconciled = reconcileUncertainCommit(options.repository, context.toolExecutionId, draft);
        if (reconciled.ok) {
          // Exact matching commit proven
          verifier.commitApproval?.(verification.approvalRecord.approvalId, context.toolExecutionId);
          return {
            ok: true,
            output: {
              draftId: reconciled.draft.draftId,
              status: reconciled.draft.status,
              externalExecution: reconciled.draft.externalExecution,
            },
          };
        }
        if (reconciled.code === "NO_COMMIT_PROVEN") {
          // Proven that no write occurred: safely release reservation for recovery
          verifier.releaseApproval?.(verification.approvalRecord.approvalId, context.toolExecutionId);
          return { ok: false, code: "DRAFT_PERSISTENCE_FAILED" };
        }
        // Conflict or indeterminate: fail closed without releasing
        return { ok: false, code: reconciled.code };
      }

      if (!saveResult.ok) {
        verifier.releaseApproval?.(verification.approvalRecord.approvalId, context.toolExecutionId);
        return { ok: false, code: saveResult.code };
      }

      // Successful persistence: commit consumption
      verifier.commitApproval?.(verification.approvalRecord.approvalId, context.toolExecutionId);

      const output: CreateChangeDraftToolOutput = {
        draftId: saveResult.draft.draftId,
        status: saveResult.draft.status,
        externalExecution: saveResult.draft.externalExecution,
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
          // Exactly the handler's derived id: an oversized or foreign id from a substituted handler is a schema mismatch.
          draftId: { type: "string", pattern: "^draft\\.[a-f0-9]{16}$" },
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
