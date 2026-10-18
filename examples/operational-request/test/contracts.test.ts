import { describe, expect, it } from "vitest";
import {
  OperationalActionProposalSchema,
  OperationalApprovalSubjectSchema,
  OperationalChangeDraftSchema,
  OperationalRequestResultSchema,
  OperationalRequestSchema,
  validateOperationalRequest,
} from "../src/contracts.js";
import { VALID_OPERATIONAL_REQUEST } from "../fixtures/requests.js";

describe("Operational Request Contracts", () => {
  it("validates a conforming OperationalRequest", () => {
    const parsed = OperationalRequestSchema.safeParse(VALID_OPERATIONAL_REQUEST);
    expect(parsed.success).toBe(true);
    const result = validateOperationalRequest(VALID_OPERATIONAL_REQUEST);
    expect(result.ok).toBe(true);
  });

  it("rejects an OperationalRequest with invalid request ID", () => {
    const invalid = { ...VALID_OPERATIONAL_REQUEST, requestId: "bad id with spaces!" };
    const result = validateOperationalRequest(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_OPERATIONAL_REQUEST");
    }
  });

  it("rejects an OperationalRequest with missing account context", () => {
    const invalid = {
      schemaVersion: 1,
      requestId: "req-001",
      instruction: "Do something with account",
    };
    const result = validateOperationalRequest(invalid);
    expect(result.ok).toBe(false);
  });

  it("rejects an OperationalRequest with extra unexpected properties (strict)", () => {
    const invalid = {
      ...VALID_OPERATIONAL_REQUEST,
      permissionClasses: ["external_side_effect"],
    };
    const result = validateOperationalRequest(invalid);
    expect(result.ok).toBe(false);
  });

  it("validates conforming OperationalActionProposal", () => {
    const proposal = {
      operation: "account.update_display_name",
      target: { accountId: "ACME-001" },
      changes: { displayName: "Acme Data Solutions" },
      justification: "Valid change justification for review.",
    };
    expect(OperationalActionProposalSchema.safeParse(proposal).success).toBe(true);
  });

  it("rejects proposal with unsupported operation", () => {
    const proposal = {
      operation: "crm.accounts.delete",
      target: { accountId: "ACME-001" },
      changes: { displayName: "Acme Data Solutions" },
      justification: "Unsupported operation proposal.",
    };
    expect(OperationalActionProposalSchema.safeParse(proposal).success).toBe(false);
  });

  it("validates conforming OperationalApprovalSubject", () => {
    const subject = {
      schemaVersion: 1,
      requestId: "req-001",
      operation: "account.update_display_name",
      accountId: "ACME-001",
      proposedChanges: { displayName: "Acme Data Solutions" },
      executionMode: "draft_only",
    };
    expect(OperationalApprovalSubjectSchema.safeParse(subject).success).toBe(true);
  });

  it("rejects approval subject with non-draft_only execution mode", () => {
    const subject = {
      schemaVersion: 1,
      requestId: "req-001",
      operation: "account.update_display_name",
      accountId: "ACME-001",
      proposedChanges: { displayName: "Acme Data Solutions" },
      executionMode: "live_mutation",
    };
    expect(OperationalApprovalSubjectSchema.safeParse(subject).success).toBe(false);
  });

  it("validates conforming OperationalChangeDraft", () => {
    const draft = {
      schemaVersion: 1,
      draftId: "draft.12345678abcdef01",
      requestId: "req-001",
      operation: "account.update_display_name",
      accountId: "ACME-001",
      proposedChanges: { displayName: "Acme Data Solutions" },
      approvalId: "approval:abcdef123456",
      status: "approved_draft",
      externalExecution: "not_executed",
    };
    expect(OperationalChangeDraftSchema.safeParse(draft).success).toBe(true);
  });

  it("validates conforming OperationalRequestResult", () => {
    const result = {
      schemaVersion: 1,
      requestId: "req-001",
      operation: "account.update_display_name",
      accountId: "ACME-001",
      draftId: "draft.12345678abcdef01",
      approvalId: "approval:abcdef123456",
      draftStatus: "approved_draft",
      externalExecution: "not_executed",
      outcome: "completed",
      renderedMarkdown: "# Result\nThe draft was prepared. The external account was not modified.",
    };
    expect(OperationalRequestResultSchema.safeParse(result).success).toBe(true);
  });
});
