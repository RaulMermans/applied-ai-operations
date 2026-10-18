import { describe, expect, it } from "vitest";
import {
  createFixtureProof,
  manager,
  VALID_OPERATIONAL_REQUEST,
} from "../fixtures/index.js";
import { STATE_KEYS, type OperationalRequestResult } from "../src/index.js";
import { failureCode, failureNodeId } from "./support.js";


describe("Operational Request Workflow Execution", () => {
  it("initial execution reaches WAITING_FOR_APPROVAL and invokes zero draft tool calls", async () => {
    const { proof } = createFixtureProof();
    const result = await proof.execute({
      runId: "run.test.waitpoint",
      request: VALID_OPERATIONAL_REQUEST,
    });

    expect(result.ok).toBe(true);
    expect(result.execution?.run.status).toBe("WAITING_FOR_APPROVAL");
    expect(result.execution?.wait?.kind).toBe("approval");
    expect(result.execution?.wait?.referenceId).toMatch(/^approval:[a-f0-9]{64}$/);
    expect(result.execution?.wait?.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);

    // Invariant: Zero draft tool calls before approval
    expect(proof.draftRepository.getAllDrafts().length).toBe(0);
  });

  it("approved continuation executes write_draft tool once, stages draft, and completes", async () => {
    const { proof } = createFixtureProof();
    const initial = await proof.execute({
      runId: "run.test.approved-flow",
      request: VALID_OPERATIONAL_REQUEST,
    });

    const approvalId = initial.execution?.wait?.referenceId;
    expect(approvalId).toBeDefined();
    if (!approvalId) throw new Error("Expected approval waitpoint");

    // Human manager approves
    const record = proof.approvals.approve(approvalId, manager);
    expect(record.status).toBe("approved");

    // Canonical continuation
    const resumed = await proof.continue(initial.execution!);
    expect(resumed.ok).toBe(true);
    expect(resumed.execution?.run.status).toBe("COMPLETED");

    // Draft staged locally in repository
    const drafts = proof.draftRepository.getAllDrafts();
    expect(drafts.length).toBe(1);
    const draft = drafts[0]!;
    expect(draft.accountId).toBe("ACME-001");
    expect(draft.proposedChanges.displayName).toBe("Acme Data Solutions");
    expect(draft.status).toBe("approved_draft");
    expect(draft.externalExecution).toBe("not_executed");

    // Final result contract
    const finalResult = resumed.execution?.state.values[STATE_KEYS.finalResult] as unknown as OperationalRequestResult;
    expect(finalResult).toBeDefined();
    expect(finalResult.outcome).toBe("completed");
    expect(finalResult.externalExecution).toBe("not_executed");
    expect(finalResult.renderedMarkdown).toContain("The draft was prepared. The external account was not modified.");
  });

  it("rejected continuation terminates with APPROVAL_REJECTED and zero drafts", async () => {
    const { proof } = createFixtureProof();
    const initial = await proof.execute({
      runId: "run.test.rejected-flow",
      request: VALID_OPERATIONAL_REQUEST,
    });

    const approvalId = initial.execution?.wait?.referenceId;
    expect(approvalId).toBeDefined();
    if (!approvalId) throw new Error("Expected approval waitpoint");

    // Human manager rejects
    const record = proof.approvals.reject(approvalId, manager);
    expect(record.status).toBe("rejected");

    // Canonical continuation
    const resumed = await proof.continue(initial.execution!);
    expect(resumed.ok).toBe(false);
    expect(failureCode(resumed)).toBe("APPROVAL_REJECTED");
    expect(resumed.execution?.run.status).toBe("FAILED");

    // Invariant: Zero drafts created on rejection
    expect(proof.draftRepository.getAllDrafts().length).toBe(0);
  });

  it("attempting continuation while approval is still pending fails without draft creation", async () => {
    const { proof } = createFixtureProof();
    const initial = await proof.execute({
      runId: "run.test.pending-continuation",
      request: VALID_OPERATIONAL_REQUEST,
    });

    // Continue without resolving approval
    const resumed = await proof.continue(initial.execution!);
    expect(resumed.ok).toBe(false);
    expect(failureCode(resumed)).toBe("APPROVAL_STILL_PENDING");

    // Invariant: Zero drafts created
    expect(proof.draftRepository.getAllDrafts().length).toBe(0);
  });

  it("terminates before approval if model proposal is invalid", async () => {
    const { proof } = createFixtureProof({
      modelOptions: { unsupportedOperation: true },
    });
    const result = await proof.execute({
      runId: "run.test.invalid-proposal",
      request: VALID_OPERATIONAL_REQUEST,
    });

    expect(result.ok).toBe(false);
    expect(failureCode(result)).toBe("NODE_EXECUTION_FAILED");
    expect(failureNodeId(result)).toBe("validate_proposal");
    expect(result.execution?.run.status).toBe("FAILED");

    // Invariant: Zero approval requested, zero drafts created
    expect(proof.draftRepository.getAllDrafts().length).toBe(0);
  });
});
