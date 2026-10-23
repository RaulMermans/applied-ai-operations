import { describe, expect, it } from "vitest";
import { createCompanyAAO } from "@aao/example-company-portability";
import {
  createStandardPackCatalog,
  resolveCompanyCapabilityPacks,
  type CompanyResearchFacade,
  type DocumentIntelligenceFacade,
  type OperationalRequestFacade,
} from "../src/index.js";
import {
  createTestHostEnvironment,
  NORTHSTAR_MANIFEST,
  ARBOR_MANIFEST,
  NORTHSTAR_ACTORS,
  ARBOR_ACTORS,
  NORTHSTAR_PACK_SELECTION,
  ARBOR_PACK_SELECTION,
  NORTHSTAR_RESEARCH_REQUEST,
  ARBOR_RESEARCH_REQUEST,
  NORTHSTAR_DOC_REQUEST,
  ARBOR_DOC_REQUEST,
  NORTHSTAR_OPERATIONAL_REQUEST,
  ARBOR_OPERATIONAL_REQUEST,
} from "../fixtures/index.js";

describe("Sprint 26 — Six-Scenario Capability Pack Adoption Matrix", () => {
  it("executes the full 3x2 matrix: all three Capability Packs across both companies", async () => {
    const env = createTestHostEnvironment();
    const catalog = createStandardPackCatalog();

    // 1. Compose Northstar AAO & Arbor AAO using canonical composition
    const northstarAAO = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });

    const arborAAO = createCompanyAAO({
      manifest: ARBOR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.arborPrincipalForRun,
    });

    expect(northstarAAO.configFingerprint).not.toBe(arborAAO.configFingerprint);

    // 2. Select and activate Capability Packs for Northstar Commerce
    const northstarPacks = resolveCompanyCapabilityPacks({
      company: northstarAAO,
      catalog,
      selection: NORTHSTAR_PACK_SELECTION,
    });

    // 3. Select and activate Capability Packs for Arbor Consulting
    const arborPacks = resolveCompanyCapabilityPacks({
      company: arborAAO,
      catalog,
      selection: ARBOR_PACK_SELECTION,
    });

    expect(northstarPacks.listPacks()).toHaveLength(3);
    expect(arborPacks.listPacks()).toHaveLength(3);

    // 4. Verify Identity Invariants:
    // Identical Pack fingerprints and identical Workflow plan fingerprints across both companies
    for (const ref of NORTHSTAR_PACK_SELECTION.packRefs) {
      const nsPack = northstarPacks.getPack(ref);
      const arbPack = arborPacks.getPack(ref);

      expect(nsPack.packFingerprint).toBe(arbPack.packFingerprint);
      expect(nsPack.workflowPlanFingerprint).toBe(arbPack.workflowPlanFingerprint);
      expect(nsPack.pack.identity).toBe(arbPack.pack.identity);
      expect(nsPack.compatibilityReport.compatible).toBe(true);
      expect(arbPack.compatibilityReport.compatible).toBe(true);
      expect(nsPack.compatibilityReport.verifiedRequirements.evalProfiles).toBe(1);
      expect(arbPack.compatibilityReport.verifiedRequirements.evalProfiles).toBe(1);
    }

    // ==============================================================
    // SCENARIO 1: Northstar Commerce x aao.company-research@1.0.0
    // ==============================================================
    const nsResearchPack = northstarPacks.getPack<CompanyResearchFacade>("aao.company-research@1.0.0");
    const nsResearchOutcome = await nsResearchPack.facade.run({
      runId: "run.ns.pack.research",
      request: NORTHSTAR_RESEARCH_REQUEST,
    });

    expect(nsResearchOutcome.status).toBe("completed");
    if (nsResearchOutcome.status === "completed") {
      expect(nsResearchOutcome.result.coverage.questionsAnswered).toBe(3);
      expect(nsResearchOutcome.result.coverage.sourcesCited).toBe(3);
      expect(nsResearchOutcome.result.markdown).toContain("Northstar Commerce");
    }

    // ==============================================================
    // SCENARIO 2: Arbor Consulting x aao.company-research@1.0.0
    // ==============================================================
    const arbResearchPack = arborPacks.getPack<CompanyResearchFacade>("aao.company-research@1.0.0");
    const arbResearchOutcome = await arbResearchPack.facade.run({
      runId: "run.arb.pack.research",
      request: ARBOR_RESEARCH_REQUEST,
    });

    expect(arbResearchOutcome.status).toBe("completed");
    if (arbResearchOutcome.status === "completed") {
      expect(arbResearchOutcome.result.coverage.questionsAnswered).toBe(3);
      expect(arbResearchOutcome.result.coverage.sourcesCited).toBe(3);
      expect(arbResearchOutcome.result.markdown).toContain("Arbor Consulting");
    }

    // ==============================================================
    // SCENARIO 3: Northstar Commerce x aao.document-intelligence@1.0.0
    // ==============================================================
    const nsDocPack = northstarPacks.getPack<DocumentIntelligenceFacade>("aao.document-intelligence@1.0.0");
    const nsDocOutcome = await nsDocPack.facade.run({
      runId: "run.ns.pack.doc",
      request: NORTHSTAR_DOC_REQUEST,
    });

    expect(nsDocOutcome.status).toBe("completed");
    if (nsDocOutcome.status === "completed") {
      expect(nsDocOutcome.result.coverage.questionsAnswered).toBe(1);
      expect(nsDocOutcome.result.markdown).toContain("Supplier terms");
    }

    // ==============================================================
    // SCENARIO 4: Arbor Consulting x aao.document-intelligence@1.0.0
    // ==============================================================
    const arbDocPack = arborPacks.getPack<DocumentIntelligenceFacade>("aao.document-intelligence@1.0.0");
    const arbDocOutcome = await arbDocPack.facade.run({
      runId: "run.arb.pack.doc",
      request: ARBOR_DOC_REQUEST,
    });

    expect(arbDocOutcome.status).toBe("completed");
    if (arbDocOutcome.status === "completed") {
      expect(arbDocOutcome.result.coverage.questionsAnswered).toBe(1);
      expect(arbDocOutcome.result.markdown).toContain("Consulting terms");
    }

    // ==============================================================
    // SCENARIO 5: Northstar Commerce x aao.operational-request@1.0.0
    // ==============================================================
    const nsOpsPack = northstarPacks.getPack<OperationalRequestFacade>("aao.operational-request@1.0.0");
    const nsOpsInit = await nsOpsPack.facade.execute({
      runId: "run.ns.pack.ops",
      request: NORTHSTAR_OPERATIONAL_REQUEST,
    });

    expect(nsOpsInit.ok).toBe(true);
    if (!nsOpsInit.ok) return;
    expect(nsOpsInit.execution.run.status).toBe("WAITING_FOR_APPROVAL");

    const nsWaitRef = nsOpsInit.execution.wait?.referenceId as string;
    await nsOpsPack.facade.approvals.approve(nsWaitRef, NORTHSTAR_ACTORS.manager);

    const nsOpsResume = await nsOpsPack.facade.continue(nsOpsInit.execution);
    expect(nsOpsResume.ok).toBe(true);
    if (!nsOpsResume.ok) return;
    expect(nsOpsResume.execution.run.status).toBe("COMPLETED");

    // ==============================================================
    // SCENARIO 6: Arbor Consulting x aao.operational-request@1.0.0
    // ==============================================================
    const arbOpsPack = arborPacks.getPack<OperationalRequestFacade>("aao.operational-request@1.0.0");
    const arbOpsInit = await arbOpsPack.facade.execute({
      runId: "run.arb.pack.ops",
      request: ARBOR_OPERATIONAL_REQUEST,
    });

    expect(arbOpsInit.ok).toBe(true);
    if (!arbOpsInit.ok) return;
    expect(arbOpsInit.execution.run.status).toBe("WAITING_FOR_APPROVAL");

    const arbWaitRef = arbOpsInit.execution.wait?.referenceId as string;
    await arbOpsPack.facade.approvals.approve(arbWaitRef, ARBOR_ACTORS.manager);

    const arbOpsResume = await arbOpsPack.facade.continue(arbOpsInit.execution);
    expect(arbOpsResume.ok).toBe(true);
    if (!arbOpsResume.ok) return;
    expect(arbOpsResume.execution.run.status).toBe("COMPLETED");

    // Verify provider calls isolated to respective companies
    expect(env.northstarDraftRepo.getAllDrafts().length).toBeGreaterThan(0);
    expect(env.arborDraftRepo.getAllDrafts().length).toBeGreaterThan(0);
    expect(env.getArborProviderCalls()).toBeGreaterThan(0);
  });
});
