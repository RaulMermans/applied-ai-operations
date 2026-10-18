import { describe, expect, it } from "vitest";
import { validateOperationalProposal } from "../src/validation.js";
import { VALID_OPERATIONAL_REQUEST } from "../fixtures/requests.js";

describe("Proposal Validation (Deterministic Boundary)", () => {
  it("accepts a conforming proposal that matches intake context", () => {
    const raw = {
      operation: "account.update_display_name",
      target: { accountId: "ACME-001" },
      changes: { displayName: "Acme Data Solutions" },
      justification: "Valid change requested by operator.",
    };
    const result = validateOperationalProposal(raw, VALID_OPERATIONAL_REQUEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.operation).toBe("account.update_display_name");
      expect(result.proposal.target.accountId).toBe("ACME-001");
      expect(result.proposal.changes.displayName).toBe("Acme Data Solutions");
    }
  });

  it("rejects an unsupported operation not on allowlist", () => {
    const raw = {
      operation: "account.delete_record",
      target: { accountId: "ACME-001" },
      changes: { displayName: "Acme Data Solutions" },
      justification: "Deletion requested.",
    };
    const result = validateOperationalProposal(raw, VALID_OPERATIONAL_REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PROPOSAL_UNSUPPORTED_OPERATION");
    }
  });

  it("rejects an account ID that does not match trusted intake context", () => {
    const raw = {
      operation: "account.update_display_name",
      target: { accountId: "ACME-999-DIFFERENT" },
      changes: { displayName: "Acme Data Solutions" },
      justification: "Account swap attempt.",
    };
    const result = validateOperationalProposal(raw, VALID_OPERATIONAL_REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PROPOSAL_ACCOUNT_MISMATCH");
    }
  });

  it("rejects unsupported change fields", () => {
    const raw = {
      operation: "account.update_display_name",
      target: { accountId: "ACME-001" },
      changes: { displayName: "Acme Data Solutions", creditLimit: 500000 },
      justification: "Added unauthorized field.",
    };
    const result = validateOperationalProposal(raw, VALID_OPERATIONAL_REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PROPOSAL_UNSUPPORTED_CHANGES");
    }
  });

  it("rejects blank or invalid display name", () => {
    const raw = {
      operation: "account.update_display_name",
      target: { accountId: "ACME-001" },
      changes: { displayName: "   " },
      justification: "Blank name.",
    };
    const result = validateOperationalProposal(raw, VALID_OPERATIONAL_REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PROPOSAL_INVALID_DISPLAY_NAME");
    }
  });

  it("rejects executable code / script injection in display name", () => {
    const raw = {
      operation: "account.update_display_name",
      target: { accountId: "ACME-001" },
      changes: { displayName: "<script>alert('pwned')</script>" },
      justification: "XSS injection attempt.",
    };
    const result = validateOperationalProposal(raw, VALID_OPERATIONAL_REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PROPOSAL_INVALID_DISPLAY_NAME");
    }
  });

  it("rejects proposals containing forbidden permission metadata", () => {
    const raw = {
      operation: "account.update_display_name",
      target: { accountId: "ACME-001" },
      changes: { displayName: "Acme Data Solutions" },
      permissionClasses: ["external_side_effect"],
      justification: "Trying to self-grant permissions.",
    };
    const result = validateOperationalProposal(raw, VALID_OPERATIONAL_REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PROPOSAL_FORBIDDEN_METADATA");
    }
  });

  it("rejects proposals containing approval status metadata", () => {
    const raw = {
      operation: "account.update_display_name",
      target: { accountId: "ACME-001" },
      changes: { displayName: "Acme Data Solutions" },
      approved: true,
      status: "approved",
      justification: "Trying to auto-approve.",
    };
    const result = validateOperationalProposal(raw, VALID_OPERATIONAL_REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PROPOSAL_FORBIDDEN_METADATA");
    }
  });

  it("rejects proposals containing injected tool reference", () => {
    const raw = {
      operation: "account.update_display_name",
      target: { accountId: "ACME-001" },
      changes: { displayName: "Acme Data Solutions" },
      toolRef: "crm.update_record",
      justification: "Trying to choose own tool.",
    };
    const result = validateOperationalProposal(raw, VALID_OPERATIONAL_REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PROPOSAL_FORBIDDEN_METADATA");
    }
  });

  it("rejects non-object proposal values", () => {
    const result = validateOperationalProposal("not an object", VALID_OPERATIONAL_REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PROPOSAL_VALIDATION_FAILED");
    }
  });
});
