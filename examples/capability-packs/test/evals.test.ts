import { beforeAll, describe, expect, it } from "vitest";
import {
  createInMemoryTraceStore,
  createTraceRecorder,
} from "@aao/observability";
import {
  createEvaluatorRegistry,
  type EvalEvidenceBundle,
  type ExecutionEvidence,
} from "@aao/evaluation";
import {
  CapabilityPackError,
  COMPANY_RESEARCH_PACK_MANIFEST,
  createCapabilityPackCatalog,
  defineCapabilityPack,
} from "@aao/capability-packs";
import { createCompanyAAO } from "@aao/example-company-portability";
import {
  createStandardPackCatalog,
  createStandardEvalProfileCatalog,
  createPackEvalProfileCatalog,
  verifyEvalProfileRegistration,
  buildPackEvalDataset,
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

  let sharedNorthstarAAO: ReturnType<typeof createCompanyAAO>;

  beforeAll(async () => {
    const trace = createTraceRecorder({ store });
    const northstarAAO = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
      trace,
    });
    sharedNorthstarAAO = northstarAAO;

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

  it("Section 29.1: registers all three flagship Eval profiles in the standard profile catalog", () => {
    const evalCatalog = createStandardEvalProfileCatalog();
    expect(evalCatalog.listProfileRefs()).toEqual([
      "aao.company-research.evals@1.0.0",
      "aao.document-intelligence.evals@1.0.0",
      "aao.operational-request.evals@1.0.0",
    ]);
    expect(evalCatalog.hasProfile(EVAL_PROFILES.companyResearch)).toBe(true);
    expect(evalCatalog.hasProfile(EVAL_PROFILES.documentIntelligence)).toBe(true);
    expect(evalCatalog.hasProfile(EVAL_PROFILES.operationalRequest)).toBe(true);
  });

  it("Section 29.2: rejects unknown Eval profile with PACK_VERIFICATION_PROFILE_MISSING", () => {
    const unknownEvalPack = defineCapabilityPack({
      ...COMPANY_RESEARCH_PACK_MANIFEST,
      verification: {
        evalProfileRef: "aao.unknown.evals@1.0.0",
      },
    });
    const customCatalog = createCapabilityPackCatalog([unknownEvalPack]);

    expect(() =>
      resolveCompanyCapabilityPacks({
        company: sharedNorthstarAAO,
        catalog: customCatalog,
        selection: {
          schemaVersion: 1,
          companyId: "northstar-commerce",
          packRefs: [{ id: "aao.company-research", version: "1.0.0" }],
        },
      })
    ).toThrow(CapabilityPackError);

    expect(() =>
      resolveCompanyCapabilityPacks({
        company: sharedNorthstarAAO,
        catalog: customCatalog,
        selection: {
          schemaVersion: 1,
          companyId: "northstar-commerce",
          packRefs: [{ id: "aao.company-research", version: "1.0.0" }],
        },
      })
    ).toThrow(/PACK_VERIFICATION_PROFILE_MISSING/);
  });

  it("Section 29.3: rejects wrong Eval profile version with PACK_VERIFICATION_PROFILE_MISSING", () => {
    const wrongVersionPack = defineCapabilityPack({
      ...COMPANY_RESEARCH_PACK_MANIFEST,
      verification: {
        evalProfileRef: "aao.company-research.evals@2.0.0",
      },
    });
    const customCatalog = createCapabilityPackCatalog([wrongVersionPack]);

    expect(() =>
      resolveCompanyCapabilityPacks({
        company: sharedNorthstarAAO,
        catalog: customCatalog,
        selection: {
          schemaVersion: 1,
          companyId: "northstar-commerce",
          packRefs: [{ id: "aao.company-research", version: "1.0.0" }],
        },
      })
    ).toThrow(/PACK_VERIFICATION_PROFILE_MISSING/);
  });

  it("Section 29.4: rejects arbitrary string Eval profile ref during manifest validation and catalog creation", () => {
    expect(() =>
      defineCapabilityPack({
        ...COMPANY_RESEARCH_PACK_MANIFEST,
        verification: {
          evalProfileRef: "arbitrary-unversioned-profile",
        },
      })
    ).toThrow(/PACK_INVALID_MANIFEST/);

    expect(() =>
      createPackEvalProfileCatalog({
        profiles: [
          {
            profileRef: "invalid_id@not-semver",
            buildDataset: () => {
              throw new Error("unreachable");
            },
          },
        ],
      })
    ).toThrow(/PACK_VERIFICATION_PROFILE_MISSING/);
  });

  it("Section 29.5: rejects Eval profile whose builder is unavailable or throws", () => {
    expect(() =>
      createPackEvalProfileCatalog({
        profiles: [
          {
            profileRef: "aao.company-research.evals@1.0.0",
            buildDataset: undefined as unknown as () => never,
          },
        ],
      })
    ).toThrow(/PACK_VERIFICATION_PROFILE_MISSING/);

    expect(() =>
      createPackEvalProfileCatalog({
        profiles: [
          {
            profileRef: "aao.company-research.evals@1.0.0",
            buildDataset: () => {
              throw new Error("Builder broken");
            },
          },
        ],
      })
    ).toThrow(/PACK_VERIFICATION_PROFILE_MISSING/);
  });

  it("Section 29.6: rejects Eval profile whose required grader is unavailable in the EvaluatorRegistry", () => {
    const emptyEvaluatorRegistry = createEvaluatorRegistry([]);
    const evalCatalog = createStandardEvalProfileCatalog();

    expect(() =>
      verifyEvalProfileRegistration(evalCatalog, EVAL_PROFILES.companyResearch, emptyEvaluatorRegistry)
    ).toThrow(/PACK_VERIFICATION_PROFILE_MISSING.*requires grader/);
  });

  it("Section 29.7 & 29.8: profile registration does not execute the Eval dataset during activation, and profile remains usable after activation", async () => {
    let builderCalls = 0;

    const trackedEvalCatalog = createPackEvalProfileCatalog({
      profiles: [
        {
          profileRef: EVAL_PROFILES.companyResearch,
          buildDataset: (evidenceKey: string) => {
            builderCalls += 1;
            return buildPackEvalDataset(EVAL_PROFILES.companyResearch, evidenceKey);
          },
        },
        {
          profileRef: EVAL_PROFILES.documentIntelligence,
          buildDataset: (evidenceKey: string) =>
            buildPackEvalDataset(EVAL_PROFILES.documentIntelligence, evidenceKey),
        },
        {
          profileRef: EVAL_PROFILES.operationalRequest,
          buildDataset: (evidenceKey: string) =>
            buildPackEvalDataset(EVAL_PROFILES.operationalRequest, evidenceKey),
        },
      ],
    });

    // Catalog creation calls buildDataset once with dry-run probe to validate contracts, without running any eval dataset
    expect(builderCalls).toBe(1);

    const northstarAAO = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });
    const catalog = createStandardPackCatalog();

    const callsBeforeActivation = env.getArborProviderCalls();
    const activated = resolveCompanyCapabilityPacks({
      company: northstarAAO,
      catalog,
      selection: NORTHSTAR_PACK_SELECTION,
      evalProfileCatalog: trackedEvalCatalog,
    });

    // Activation verifies registration without executing eval suites or provider calls
    expect(builderCalls).toBe(1);
    expect(env.getArborProviderCalls()).toBe(callsBeforeActivation);
    expect(activated.listPacks()).toHaveLength(3);

    // Post-run evaluation remains usable with the tracked catalog
    const summary = await evaluatePackRun({
      profileRef: EVAL_PROFILES.companyResearch,
      evidenceKey: "run://eval.cr",
      evidenceMap,
      evalProfileCatalog: trackedEvalCatalog,
    });
    expect(builderCalls).toBe(2);
    expect(summary.allMatched).toBe(true);
  });
});
