import { beforeAll, describe, expect, it } from "vitest";
import {
  createInMemoryTraceStore,
  createTraceRecorder,
} from "@aao/observability";
import type { EvalEvidenceBundle, ExecutionEvidence } from "@aao/evaluation";
import { createCompanyAAO } from "@aao/example-company-portability";
import {
  createStandardPackCatalog,
  resolveCompanyCapabilityPacks,
  evaluatePackRun,
  EVAL_PROFILES,
  type CompanyResearchFacade,
  type DocumentIntelligenceFacade,
  type OperationalRequestFacade,
} from "../src/index.js";
import {
  createTestHostEnvironment,
  NORTHSTAR_MANIFEST,
  NORTHSTAR_ACTORS,
  NORTHSTAR_PACK_SELECTION,
  NORTHSTAR_RESEARCH_REQUEST,
  NORTHSTAR_DOC_REQUEST,
  NORTHSTAR_OPERATIONAL_REQUEST,
} from "../fixtures/index.js";

describe("Sprint 26 — Capability Pack Evaluation Profiles", () => {
  const store = createInMemoryTraceStore();
  const env = createTestHostEnvironment();
  const evidenceMap = new Map<string, EvalEvidenceBundle>();

  beforeAll(async () => {
    const trace = createTraceRecorder({ store });
    const northstarAAO = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
      trace,
    });

    const catalog = createStandardPackCatalog();
    const northstarPacks = resolveCompanyCapabilityPacks({
      company: northstarAAO,
      catalog,
      selection: NORTHSTAR_PACK_SELECTION,
    });

    // 1. Run Company Research Pack
    const crPack = northstarPacks.getPack<CompanyResearchFacade>("aao.company-research@1.0.0");
    const crOutcome = await crPack.facade.run({
      runId: "run.eval.pack.cr",
      request: NORTHSTAR_RESEARCH_REQUEST,
    });
    const crTrace = await store.getRunTrace("run.eval.pack.cr");
    evidenceMap.set("run://eval.cr", {
      origin: "live_run",
      runId: "run.eval.pack.cr",
      trace: crTrace,
      execution: (crOutcome as unknown as { execution: { execution: ExecutionEvidence } }).execution.execution,
    });

    // 2. Run Document Intelligence Pack
    const diPack = northstarPacks.getPack<DocumentIntelligenceFacade>("aao.document-intelligence@1.0.0");
    const diOutcome = await diPack.facade.run({
      runId: "run.eval.pack.di",
      request: NORTHSTAR_DOC_REQUEST,
    });
    const diTrace = await store.getRunTrace("run.eval.pack.di");
    evidenceMap.set("run://eval.di", {
      origin: "live_run",
      runId: "run.eval.pack.di",
      trace: diTrace,
      execution: (diOutcome as unknown as { execution: { execution: ExecutionEvidence } }).execution.execution,
    });

    // 3. Run Operational Request Pack
    const orPack = northstarPacks.getPack<OperationalRequestFacade>("aao.operational-request@1.0.0");
    const orInit = await orPack.facade.execute({
      runId: "run.eval.pack.ops",
      request: NORTHSTAR_OPERATIONAL_REQUEST,
    });
    if (orInit.ok) {
      const waitRef = orInit.execution.wait?.referenceId as string;
      await orPack.facade.approvals.approve(waitRef, NORTHSTAR_ACTORS.manager);
      const orResume = await orPack.facade.continue(orInit.execution);
      const orTrace = await store.getRunTrace("run.eval.pack.ops");
      evidenceMap.set("run://eval.ops", {
        origin: "live_run",
        runId: "run.eval.pack.ops",
        trace: orTrace,
        execution: (orResume as unknown as { execution: ExecutionEvidence }).execution,
      });
    }
  });

  it("verifies aao.company-research.evals@1.0.0 against canonical graders", async () => {
    const summary = await evaluatePackRun({
      profileRef: EVAL_PROFILES.companyResearch,
      evidenceKey: "run://eval.cr",
      evidenceMap,
    });

    expect(summary.totalCases).toBe(5);
    expect(summary.passedCases).toBe(5);
    expect(summary.failedCases).toBe(0);
    expect(summary.allMatched).toBe(true);
  });

  it("verifies aao.document-intelligence.evals@1.0.0 against canonical graders", async () => {
    const summary = await evaluatePackRun({
      profileRef: EVAL_PROFILES.documentIntelligence,
      evidenceKey: "run://eval.di",
      evidenceMap,
    });

    expect(summary.totalCases).toBe(5);
    expect(summary.passedCases).toBe(5);
    expect(summary.failedCases).toBe(0);
    expect(summary.allMatched).toBe(true);
  });

  it("verifies aao.operational-request.evals@1.0.0 against canonical graders", async () => {
    const summary = await evaluatePackRun({
      profileRef: EVAL_PROFILES.operationalRequest,
      evidenceKey: "run://eval.ops",
      evidenceMap,
    });

    expect(summary.totalCases).toBe(5);
    expect(summary.passedCases).toBe(5);
    expect(summary.failedCases).toBe(0);
    expect(summary.allMatched).toBe(true);
  });
});
