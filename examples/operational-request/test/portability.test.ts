import { describe, expect, it } from "vitest";
import {
  createFixtureProof,
  manager,
  VALID_OPERATIONAL_REQUEST,
} from "../fixtures/index.js";
import { STATE_KEYS, type OperationalRequestResult } from "../src/index.js";

describe("Model & Provider Portability (Native vs Vercel AI SDK)", () => {
  it("produces identical workflow plan fingerprints across providers", () => {
    const { proof: nativeProof } = createFixtureProof({ useVercelAdapter: false });
    const { proof: vercelProof } = createFixtureProof({ useVercelAdapter: true });

    expect(nativeProof.planFingerprint).toBe(vercelProof.planFingerprint);
    expect(nativeProof.workflow.id).toBe(vercelProof.workflow.id);
    expect(nativeProof.workflow.version).toBe(vercelProof.workflow.version);
  });

  it("produces identical execution semantics across model adapters", async () => {
    // 1. Native execution
    const { proof: nativeProof } = createFixtureProof({ useVercelAdapter: false });
    const nativeInit = await nativeProof.execute({
      runId: "run.portability.native",
      request: VALID_OPERATIONAL_REQUEST,
    });
    const nativeApprovalId = nativeInit.execution?.wait?.referenceId;
    if (!nativeApprovalId) throw new Error("Expected approval waitpoint");
    nativeProof.approvals.approve(nativeApprovalId, manager);
    const nativeResumed = await nativeProof.continue(nativeInit.execution!);

    // 2. Vercel AI SDK execution
    const { proof: vercelProof, providerCalls } = createFixtureProof({ useVercelAdapter: true });
    const vercelInit = await vercelProof.execute({
      runId: "run.portability.vercel",
      request: VALID_OPERATIONAL_REQUEST,
    });
    const vercelApprovalId = vercelInit.execution?.wait?.referenceId;
    if (!vercelApprovalId) throw new Error("Expected approval waitpoint");
    vercelProof.approvals.approve(vercelApprovalId, manager);
    const vercelResumed = await vercelProof.continue(vercelInit.execution!);

    // Verify model provider calls
    expect(providerCalls()).toBe(1);

    // Both completed
    expect(nativeResumed.ok).toBe(true);
    expect(vercelResumed.ok).toBe(true);

    // Trajectory comparison
    const nativeNodes = nativeResumed.execution?.history.map((h) => h.nodeId);
    const vercelNodes = vercelResumed.execution?.history.map((h) => h.nodeId);
    expect(nativeNodes).toEqual(vercelNodes);

    // Staged drafts comparison
    const nativeDraft = nativeProof.draftRepository.getAllDrafts()[0]!;
    const vercelDraft = vercelProof.draftRepository.getAllDrafts()[0]!;
    expect(nativeDraft.draftId).toBe(vercelDraft.draftId);
    expect(nativeDraft.accountId).toBe(vercelDraft.accountId);
    expect(nativeDraft.proposedChanges.displayName).toBe(vercelDraft.proposedChanges.displayName);
    expect(nativeDraft.status).toBe("approved_draft");
    expect(vercelDraft.status).toBe("approved_draft");
    expect(nativeDraft.externalExecution).toBe("not_executed");
    expect(vercelDraft.externalExecution).toBe("not_executed");

    // Output comparison
    const nativeResult = nativeResumed.execution?.state.values[STATE_KEYS.finalResult] as OperationalRequestResult;
    const vercelResult = vercelResumed.execution?.state.values[STATE_KEYS.finalResult] as OperationalRequestResult;
    expect(nativeResult.draftId).toBe(vercelResult.draftId);
    expect(nativeResult.outcome).toBe("completed");
    expect(vercelResult.outcome).toBe("completed");
    expect(nativeResult.externalExecution).toBe("not_executed");
    expect(vercelResult.externalExecution).toBe("not_executed");
  });
});
