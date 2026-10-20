import { describe, expect, it } from "vitest";
import { createCompanyAAO } from "../src/composition.js";
import {
  createTestHostEnvironment,
  NORTHSTAR_MANIFEST,
  ARBOR_MANIFEST,
  NORTHSTAR_ACTORS,
  ARBOR_ACTORS,
  OVERLAPPING_DOC_REF,
  NORTHSTAR_OPERATIONAL_REQUEST,
  ARBOR_OPERATIONAL_REQUEST,
} from "../fixtures/index.js";

describe("Sprint 25 — Cross-Company Governance & Execution Isolation Tests", () => {
  it("enforces Governance isolation: principal belonging only to Company A is rejected in Company B", async () => {
    // Host resolves Company A principal for all runs
    const env = createTestHostEnvironment({
      arborPrincipalOverride: () => NORTHSTAR_ACTORS.analyst, // Company A principal injected into Company B host
    });

    const arbor = createCompanyAAO({
      manifest: ARBOR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.arborPrincipalForRun,
    });

    const outcome = await arbor.runCompanyResearch({
      runId: "run.arb.unauthorized",
      request: {
        company: { name: "Arbor Consulting", domain: "arbor.example" },
        questions: [{ id: "offering", question: "What does Arbor offer?" }],
      },
    });

    // Mandatory Negative Test: Authorization Refused
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.failure.nodeId).toBe("search");
      expect(outcome.failure.executorFailure?.namespace).toBe("tool");
      expect(outcome.failure.executorFailure?.code).toBe("TOOL_AUTHORIZATION_REQUIRED");
    }

    // 0 provider calls
    expect(env.arborWebProvider.calls.search.length).toBe(0);
    expect(env.arborWebProvider.calls.fetch.length).toBe(0);
    expect(env.arborDraftRepo.getAllDrafts()).toHaveLength(0);
  });

  it("enforces Approval isolation: Company A approval cannot authorize draft execution in Company B", async () => {
    const env = createTestHostEnvironment();

    const northstar = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });

    const arbor = createCompanyAAO({
      manifest: ARBOR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.arborPrincipalForRun,
    });

    // 1. Run Northstar Operational Request until human approval waitpoint
    const nsExec = await northstar.executeOperationalRequest({
      runId: "run.ns.ops.001",
      request: NORTHSTAR_OPERATIONAL_REQUEST,
    });

    expect(nsExec.ok).toBe(true);
    if (!nsExec.ok) return;
    expect(nsExec.execution.run.status).toBe("WAITING_FOR_APPROVAL");

    const nsProof = northstar.getOperationalRequestProof();
    const wait = nsExec.execution.wait!;
    const approvalRef = wait.referenceId;
    expect(approvalRef).toBeDefined();

    // Northstar manager approves Northstar run
    await nsProof.approvals.approve(approvalRef, NORTHSTAR_ACTORS.manager);

    // 2. Run Arbor Operational Request until human approval waitpoint
    const arbExec = await arbor.executeOperationalRequest({
      runId: "run.arb.ops.001",
      request: ARBOR_OPERATIONAL_REQUEST,
    });

    expect(arbExec.ok).toBe(true);
    if (!arbExec.ok) return;
    expect(arbExec.execution.run.status).toBe("WAITING_FOR_APPROVAL");

    const arbProof = arbor.getOperationalRequestProof();

    // 3. Attempt to verify or consume Northstar's approval ID in Arbor's draft tool/verifier
    const verification = await arbProof.approvalVerifier.verifyApproval({
      approvalId: approvalRef,
      requestFingerprint: "tampered-or-real-fingerprint",
      toolExecutionId: "exec.isolation.1",
      runId: "run.arb.ops.001",
      draftPayload: {
        requestId: ARBOR_OPERATIONAL_REQUEST.requestId,
        operation: "account.update_display_name",
        accountId: ARBOR_OPERATIONAL_REQUEST.accountContext.accountId,
        proposedChanges: { displayName: "Arbor Strategic Partners" },
      },
    });

    // Mandatory Negative Test: Approval Verification Fails
    expect(verification.ok).toBe(false);
    if (!verification.ok) {
      expect(["APPROVAL_NOT_FOUND", "APPROVAL_VERIFICATION_FAILED"]).toContain(verification.code);
    }

    // 0 drafts created in Arbor's repository
    expect(env.arborDraftRepo.getAllDrafts().length).toBe(0);
  });

  it("enforces Draft repository isolation: drafts are stored strictly in the company-configured repository", async () => {
    const env = createTestHostEnvironment();

    const northstar = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });

    const arbor = createCompanyAAO({
      manifest: ARBOR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.arborPrincipalForRun,
    });

    // Execute Northstar approved draft
    const nsExec = await northstar.executeOperationalRequest({
      runId: "run.ns.ops.draft-iso",
      request: NORTHSTAR_OPERATIONAL_REQUEST,
    });
    if (!nsExec.ok) return;
    const nsWait = nsExec.execution.wait!;
    await northstar.getOperationalRequestProof().approvals.approve(
      nsWait.referenceId,
      NORTHSTAR_ACTORS.manager
    );
    const nsCont = await northstar.continueOperationalRequest(nsExec.execution);
    expect(nsCont.ok).toBe(true);

    // Northstar has 1 draft
    const nsDrafts = env.northstarDraftRepo.getAllDrafts();
    expect(nsDrafts.length).toBe(1);
    const nsDraftId = nsDrafts[0]!.draftId;

    // Arbor cannot see Northstar's draft
    expect(env.arborDraftRepo.getDraft(nsDraftId)).toBeUndefined();
    expect(env.arborDraftRepo.getAllDrafts().length).toBe(0);

    // Execute Arbor approved draft
    const arbExec = await arbor.executeOperationalRequest({
      runId: "run.arb.ops.draft-iso",
      request: ARBOR_OPERATIONAL_REQUEST,
    });
    if (!arbExec.ok) return;
    const arbWait = arbExec.execution.wait!;
    await arbor.getOperationalRequestProof().approvals.approve(
      arbWait.referenceId,
      ARBOR_ACTORS.manager
    );
    const arbCont = await arbor.continueOperationalRequest(arbExec.execution);
    expect(arbCont.ok).toBe(true);

    // Arbor has 1 draft
    const arbDrafts = env.arborDraftRepo.getAllDrafts();
    expect(arbDrafts.length).toBe(1);
    const arbDraftId = arbDrafts[0]!.draftId;

    // Northstar cannot see Arbor's draft
    expect(env.northstarDraftRepo.getDraft(arbDraftId)).toBeUndefined();
    expect(env.northstarDraftRepo.getAllDrafts().length).toBe(1);
  });

  it("enforces Document isolation: overlapping opaque references resolve strictly to company provider", async () => {
    const env = createTestHostEnvironment();

    const northstar = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });

    const arbor = createCompanyAAO({
      manifest: ARBOR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.arborPrincipalForRun,
    });

    // Both companies query the exact same document reference: "fixture.contract-001"
    const nsOutcome = await northstar.runDocumentIntelligence({
      runId: "run.ns.doc.iso",
      request: {
        documentRef: OVERLAPPING_DOC_REF,
        questions: [{ id: "terms", question: "What are the payment terms?" }],
      },
    });

    const arbOutcome = await arbor.runDocumentIntelligence({
      runId: "run.arb.doc.iso",
      request: {
        documentRef: OVERLAPPING_DOC_REF,
        questions: [{ id: "terms", question: "What are the consulting fees?" }],
      },
    });

    expect(nsOutcome.status).toBe("completed");
    expect(arbOutcome.status).toBe("completed");

    if (nsOutcome.status === "completed" && arbOutcome.status === "completed") {
      // Different document fingerprints and document IDs
      expect(nsOutcome.result.document.documentId).not.toBe(arbOutcome.result.document.documentId);
      expect(nsOutcome.result.document.documentFingerprint).not.toBe(
        arbOutcome.result.document.documentFingerprint
      );

      // Northstar content discusses supplier terms
      expect(nsOutcome.result.markdown).toContain("Supplier terms");
      expect(nsOutcome.result.markdown).not.toContain("Consulting terms");

      // Arbor content discusses consulting fees
      expect(arbOutcome.result.markdown).toContain("Consulting terms");
      expect(arbOutcome.result.markdown).not.toContain("Supplier terms");
    }

    // Provider call counts: exactly 1 for each respective provider
    expect(env.northstarDocProvider.calls.length).toBe(1);
    expect(env.arborDocProvider.calls.length).toBe(1);
  });

  it("enforces Public-web provider isolation: distinct provider calls and corpus per company", async () => {
    const env = createTestHostEnvironment();

    const northstar = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });

    const arbor = createCompanyAAO({
      manifest: ARBOR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.arborPrincipalForRun,
    });

    // Run Company A research
    await northstar.runCompanyResearch({
      runId: "run.ns.web.iso",
      request: {
        company: { name: "Northstar Commerce", domain: "northstar.example" },
        questions: [{ id: "offering", question: "What does Northstar offer?" }],
      },
    });

    expect(env.northstarWebProvider.calls.search.length).toBeGreaterThan(0);
    expect(env.northstarWebProvider.calls.fetch.length).toBeGreaterThan(0);
    // Arbor provider was called 0 times during Northstar execution
    expect(env.arborWebProvider.calls.search.length).toBe(0);
    expect(env.arborWebProvider.calls.fetch.length).toBe(0);

    // Reset calls
    env.northstarWebProvider.clearCalls();

    // Run Company B research
    await arbor.runCompanyResearch({
      runId: "run.arb.web.iso",
      request: {
        company: { name: "Arbor Consulting", domain: "arbor.example" },
        questions: [{ id: "offering", question: "What does Arbor offer?" }],
      },
    });

    expect(env.arborWebProvider.calls.search.length).toBeGreaterThan(0);
    expect(env.arborWebProvider.calls.fetch.length).toBeGreaterThan(0);
    // Northstar provider was called 0 times during Arbor execution
    expect(env.northstarWebProvider.calls.search.length).toBe(0);
    expect(env.northstarWebProvider.calls.fetch.length).toBe(0);
  });
});
