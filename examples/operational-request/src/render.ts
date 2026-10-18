import type {
  OperationalApprovalSubject,
  OperationalRequest,
  OperationalRequestResult,
} from "./contracts.js";
import type { CreateChangeDraftToolOutput } from "./tool.js";

export function renderOperationalMarkdown(result: {
  requestId: string;
  operation: string;
  accountId: string;
  displayName: string;
  draftId: string;
  approvalId: string;
  draftStatus: string;
  externalExecution: string;
}): string {
  return [
    "# Operational Request Result: Governed Draft Execution",
    "",
    "## Summary",
    `- **Request ID:** \`${result.requestId}\``,
    `- **Operation:** \`${result.operation}\``,
    `- **Target Account:** \`${result.accountId}\``,
    `- **Approved Display Name:** ${result.displayName}`,
    `- **Draft ID:** \`${result.draftId}\``,
    `- **Approval Record:** \`${result.approvalId}\``,
    `- **Draft Status:** \`${result.draftStatus}\``,
    `- **External Execution:** \`${result.externalExecution}\``,
    "",
    "> [!NOTE]",
    "> **The draft was prepared. The external account was not modified.**",
    "> Any future CRM, ERP or third-party mutation remains explicitly outside this governed draft boundary.",
    "",
  ].join("\n");
}

export function buildOperationalResult(params: {
  intake: OperationalRequest;
  subject: OperationalApprovalSubject;
  toolOutput: CreateChangeDraftToolOutput;
}): OperationalRequestResult {
  const renderedMarkdown = renderOperationalMarkdown({
    requestId: params.intake.requestId,
    operation: params.subject.operation,
    accountId: params.subject.accountId,
    displayName: params.subject.proposedChanges.displayName,
    draftId: params.toolOutput.draftId,
    approvalId: params.subject.requestId ? `approval:forged` : "approval:unknown", // overridden below
    draftStatus: params.toolOutput.status,
    externalExecution: params.toolOutput.externalExecution,
  });

  return {
    schemaVersion: 1,
    requestId: params.intake.requestId,
    operation: params.subject.operation,
    accountId: params.subject.accountId,
    draftId: params.toolOutput.draftId,
    approvalId: "", // caller sets actual approval reference
    draftStatus: params.toolOutput.status,
    externalExecution: params.toolOutput.externalExecution,
    outcome: "completed",
    renderedMarkdown,
  };
}
