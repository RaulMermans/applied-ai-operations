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

describe("Sprint 25 — Six-Scenario Company Portability Matrix", () => {
  it("executes the full 3x2 matrix: all three workflows for both companies", async () => {
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

    // ==========================================
    // 1. Company Research: Northstar Commerce
    // ==========================================
    const nsResearchOutcome = await northstar.runCompanyResearch({
      runId: "run.ns.matrix.research",
      request: {
        company: { name: "Northstar Commerce", domain: "northstar.example" },
        questions: [
          { id: "offering", question: "What does Northstar Commerce offer?" },
          { id: "customers", question: "Who are its target customers?" },
          { id: "differentiation", question: "How does it differentiate?" },
        ],
      },
    });

    expect(nsResearchOutcome.status).toBe("completed");
    if (nsResearchOutcome.status === "completed") {
      expect(nsResearchOutcome.result.coverage.questionsAnswered).toBe(3);
      expect(nsResearchOutcome.result.coverage.sourcesCited).toBe(3);
      expect(nsResearchOutcome.result.markdown).toContain("Northstar Commerce");
    }

    // ==========================================
    // 2. Company Research: Arbor Consulting
    // ==========================================
    const arbResearchOutcome = await arbor.runCompanyResearch({
      runId: "run.arb.matrix.research",
      request: {
        company: { name: "Arbor Consulting", domain: "arbor.example" },
        questions: [
          { id: "offering", question: "What services does Arbor Consulting provide?" },
          { id: "clients", question: "Who are its target clients?" },
          { id: "differentiation", question: "What differentiates its practice?" },
        ],
      },
    });

    expect(arbResearchOutcome.status).toBe("completed");
    if (arbResearchOutcome.status === "completed") {
      expect(arbResearchOutcome.result.coverage.questionsAnswered).toBe(3);
      expect(arbResearchOutcome.result.coverage.sourcesCited).toBe(3);
      expect(arbResearchOutcome.result.markdown).toContain("Arbor Consulting");
    }

    // Verify Vercel AI SDK mock adapter was invoked for Arbor
    expect(env.getArborProviderCalls()).toBeGreaterThan(0);

    // ==========================================
    // 3. Document Intelligence: Northstar Commerce
    // ==========================================
    const nsDocOutcome = await northstar.runDocumentIntelligence({
      runId: "run.ns.matrix.doc",
      request: {
        documentRef: OVERLAPPING_DOC_REF,
        questions: [{ id: "terms", question: "What are the payment terms?" }],
      },
    });

    expect(nsDocOutcome.status).toBe("completed");
    if (nsDocOutcome.status === "completed") {
      expect(nsDocOutcome.result.coverage.questionsAnswered).toBe(1);
      expect(nsDocOutcome.result.markdown).toContain("Supplier terms");
    }

    // ==========================================
    // 4. Document Intelligence: Arbor Consulting
    // ==========================================
    const arbDocOutcome = await arbor.runDocumentIntelligence({
      runId: "run.arb.matrix.doc",
      request: {
        documentRef: OVERLAPPING_DOC_REF,
        questions: [{ id: "terms", question: "What are the consulting fees?" }],
      },
    });

    expect(arbDocOutcome.status).toBe("completed");
    if (arbDocOutcome.status === "completed") {
      expect(arbDocOutcome.result.coverage.questionsAnswered).toBe(1);
      expect(arbDocOutcome.result.markdown).toContain("Consulting terms");
    }

    // ==========================================
    // 5. Operational Request: Northstar Commerce
    // ==========================================
    const nsOpsInit = await northstar.executeOperationalRequest({
      runId: "run.ns.matrix.ops",
      request: NORTHSTAR_OPERATIONAL_REQUEST,
    });

    expect(nsOpsInit.ok).toBe(true);
    if (!nsOpsInit.ok) return;
    expect(nsOpsInit.execution.run.status).toBe("WAITING_FOR_APPROVAL");

    const nsWaitRef = nsOpsInit.execution.wait?.referenceId as string;
    await northstar.getOperationalRequestProof().approvals.approve(
      nsWaitRef,
      NORTHSTAR_ACTORS.manager
    );

    const nsOpsResume = await northstar.continueOperationalRequest(nsOpsInit.execution);
    expect(nsOpsResume.ok).toBe(true);
    expect(env.northstarDraftRepo.getAllDrafts().length).toBe(1);
    expect(env.northstarDraftRepo.getAllDrafts()[0]!.proposedChanges.displayName).toBe(
      "Northstar Global Retail"
    );

    // ==========================================
    // 6. Operational Request: Arbor Consulting
    // ==========================================
    const arbOpsInit = await arbor.executeOperationalRequest({
      runId: "run.arb.matrix.ops",
      request: ARBOR_OPERATIONAL_REQUEST,
    });

    expect(arbOpsInit.ok).toBe(true);
    if (!arbOpsInit.ok) return;
    expect(arbOpsInit.execution.run.status).toBe("WAITING_FOR_APPROVAL");

    const arbWaitRef = arbOpsInit.execution.wait?.referenceId as string;
    await arbor.getOperationalRequestProof().approvals.approve(
      arbWaitRef,
      ARBOR_ACTORS.manager
    );

    const arbOpsResume = await arbor.continueOperationalRequest(arbOpsInit.execution);
    expect(arbOpsResume.ok).toBe(true);
    expect(env.arborDraftRepo.getAllDrafts().length).toBe(1);
    expect(env.arborDraftRepo.getAllDrafts()[0]!.proposedChanges.displayName).toBe(
      "Arbor Strategic Partners"
    );

    // ==========================================
    // Verify Plan Fingerprints remain identical
    // ==========================================
    expect(northstar.getCompanyResearchProof().planFingerprint).toBe(
      arbor.getCompanyResearchProof().planFingerprint
    );
    expect(northstar.getDocumentIntelligenceProof().planFingerprint).toBe(
      arbor.getDocumentIntelligenceProof().planFingerprint
    );
    expect(northstar.getOperationalRequestProof().planFingerprint).toBe(
      arbor.getOperationalRequestProof().planFingerprint
    );
  });
});
