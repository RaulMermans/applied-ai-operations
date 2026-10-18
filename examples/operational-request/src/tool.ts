import { createHash } from "node:crypto";
import { defineTool, type ToolDefinition, type ToolHandler } from "@aao/framework";
import type { OperationalChangeDraft } from "./contracts.js";
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
  };
}

export interface CreateChangeDraftToolOutput {
  [key: string]: string;
  draftId: string;
  status: "approved_draft";
  externalExecution: "not_executed";
}

/**
 * Creates the canonical `operations.create_change_draft@1.0.0` Tool.
 *
 * Permission: `write_draft`.
 * Idempotency: `execution_id`.
 * Creates a structured change draft in the host-owned repository.
 * Never modifies an external account or business system.
 */
export function createOperationalDraftTool(options: {
  repository: OperationalDraftRepository;
}): ToolDefinition {
  const handler: ToolHandler = {
    async execute(context) {
      const input = context.input as unknown as CreateChangeDraftToolInput;
      const draftId = `draft.${createHash("sha256")
        .update(`${input.requestId}:${input.accountId}:${input.proposedChanges.displayName}`)
        .digest("hex")
        .slice(0, 16)}`;

      const draft: OperationalChangeDraft = {
        schemaVersion: 1,
        draftId,
        requestId: input.requestId,
        operation: input.operation,
        accountId: input.accountId,
        proposedChanges: {
          displayName: input.proposedChanges.displayName,
        },
        approvalId: input.approvalBinding.approvalId,
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
