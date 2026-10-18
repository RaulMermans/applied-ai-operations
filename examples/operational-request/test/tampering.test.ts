import { describe, expect, it } from "vitest";
import {
  createFixtureProof,
  manager,
  VALID_OPERATIONAL_REQUEST,
} from "../fixtures/index.js";
import { STATE_KEYS } from "../src/index.js";
import type { OperationalApprovalSubject } from "../src/contracts.js";
import { failureCode } from "./support.js";

describe("Subject Tampering & Exact Approval Fingerprint Binding", () => {
  it("refuses continuation when target account ID is altered while waiting", async () => {
    const { proof } = createFixtureProof();
    const initial = await proof.execute({
      runId: "run.tamper.account",
      request: VALID_OPERATIONAL_REQUEST,
    });
    const approvalId = initial.execution?.wait?.referenceId;
    if (!approvalId) throw new Error("Expected approval waitpoint");
    proof.approvals.approve(approvalId, manager);

    // Attacker mutates accountId in execution state
    const tampered = structuredClone(initial.execution!);
    const subject = tampered.state.values[STATE_KEYS.approvalSubject] as OperationalApprovalSubject;
    subject.accountId = "ACME-TAMPERED-999";

    const resumed = await proof.continue(tampered);
    expect(resumed.ok).toBe(false);
    expect(failureCode(resumed)).toBe("APPROVAL_REQUEST_MISMATCH");
    expect(proof.draftRepository.getAllDrafts().length).toBe(0);
  });

  it("refuses continuation when proposed displayName is altered while waiting", async () => {
    const { proof } = createFixtureProof();
    const initial = await proof.execute({
      runId: "run.tamper.display-name",
      request: VALID_OPERATIONAL_REQUEST,
    });
    const approvalId = initial.execution?.wait?.referenceId;
    if (!approvalId) throw new Error("Expected approval waitpoint");
    proof.approvals.approve(approvalId, manager);

    // Attacker mutates proposed displayName
    const tampered = structuredClone(initial.execution!);
    const subject = tampered.state.values[STATE_KEYS.approvalSubject] as OperationalApprovalSubject;
    subject.proposedChanges.displayName = "Malicious Name Override";

    const resumed = await proof.continue(tampered);
    expect(resumed.ok).toBe(false);
    expect(failureCode(resumed)).toBe("APPROVAL_REQUEST_MISMATCH");
    expect(proof.draftRepository.getAllDrafts().length).toBe(0);
  });

  it("refuses continuation when operation is altered while waiting", async () => {
    const { proof } = createFixtureProof();
    const initial = await proof.execute({
      runId: "run.tamper.operation",
      request: VALID_OPERATIONAL_REQUEST,
    });
    const approvalId = initial.execution?.wait?.referenceId;
    if (!approvalId) throw new Error("Expected approval waitpoint");
    proof.approvals.approve(approvalId, manager);

    // Attacker mutates operation
    const tampered = structuredClone(initial.execution!);
    const subject = tampered.state.values[STATE_KEYS.approvalSubject] as Record<string, unknown>;
    subject.operation = "account.delete";

    const resumed = await proof.continue(tampered);
    expect(resumed.ok).toBe(false);
    expect(failureCode(resumed)).toBe("APPROVAL_REQUEST_MISMATCH");
    expect(proof.draftRepository.getAllDrafts().length).toBe(0);
  });

  it("refuses continuation when executionMode is altered while waiting", async () => {
    const { proof } = createFixtureProof();
    const initial = await proof.execute({
      runId: "run.tamper.execution-mode",
      request: VALID_OPERATIONAL_REQUEST,
    });
    const approvalId = initial.execution?.wait?.referenceId;
    if (!approvalId) throw new Error("Expected approval waitpoint");
    proof.approvals.approve(approvalId, manager);

    // Attacker mutates executionMode
    const tampered = structuredClone(initial.execution!);
    const subject = tampered.state.values[STATE_KEYS.approvalSubject] as Record<string, unknown>;
    subject.executionMode = "live_mutation";

    const resumed = await proof.continue(tampered);
    expect(resumed.ok).toBe(false);
    expect(failureCode(resumed)).toBe("APPROVAL_REQUEST_MISMATCH");
    expect(proof.draftRepository.getAllDrafts().length).toBe(0);
  });

  it("refuses continuation when forged approvalId is provided in wait reference", async () => {
    const { proof } = createFixtureProof();
    const initial = await proof.execute({
      runId: "run.tamper.forged-approval-id",
      request: VALID_OPERATIONAL_REQUEST,
    });

    const tampered = structuredClone(initial.execution!);
    tampered.wait!.referenceId = "approval:0000000000000000000000000000000000000000000000000000000000000000";

    const resumed = await proof.continue(tampered);
    expect(resumed.ok).toBe(false);
    expect(failureCode(resumed)).toBe("INVALID_APPROVAL_CONTEXT");
    expect(proof.draftRepository.getAllDrafts().length).toBe(0);
  });
});
