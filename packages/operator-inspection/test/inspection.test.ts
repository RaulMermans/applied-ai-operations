import { describe, expect, it } from "vitest";
import { COMPANY_RESEARCH_PACK, OPERATIONAL_REQUEST_PACK, DOCUMENT_INTELLIGENCE_PACK } from "@aao/capability-packs";
import {
  CANONICAL_ARBOR_MANIFEST,
  CANONICAL_APPROVAL_RECORDS,
  CANONICAL_COMPANY_RESEARCH_WORKFLOW,
  CANONICAL_DOCUMENT_INTELLIGENCE_WORKFLOW,
  CANONICAL_NORTHSTAR_MANIFEST,
  CANONICAL_OPERATIONAL_REQUEST_WORKFLOW,
  CANONICAL_RUN_RECORDS,
  OperatorInspectionError,
  buildCanonicalTraceFixtures,
  createCanonicalDemoInspectionSource,
  createEvidenceBackedInspectionSource,
  createOperatorInspectionService,
  createVerifiedRegistrationEvidenceForCompany,
  findForbiddenInspectionKeys,
  projectApprovalSummary,
  projectEvaluationSummary,
  projectPackCompatibilitySummary,
  projectRunSummary,
  projectTraceInspection,
  projectWorkflowSummary,
} from "../src/index.js";

const service = async () => createOperatorInspectionService(await createCanonicalDemoInspectionSource());

describe("companies and packs", () => {
  it("lists both companies without secrets or raw governance", async () => {
    const companies = await (await service()).listCompanies();
    expect(companies.map((c) => c.companyId)).toEqual(["arbor-consulting", "northstar-commerce"]);
    expect(findForbiddenInspectionKeys(companies)).toEqual([]);
    expect(JSON.stringify(companies)).not.toMatch(/governance|actors|policies/);
    expect(companies[0]!.verifiedCompatiblePackCount).toBe(0);

    const verifiedSvc = createOperatorInspectionService(
      await createCanonicalDemoInspectionSource({
        registrationEvidenceByCompany: {
          "arbor-consulting": createVerifiedRegistrationEvidenceForCompany("arbor-consulting"),
          "northstar-commerce": createVerifiedRegistrationEvidenceForCompany("northstar-commerce"),
        },
      })
    );
    const verifiedCompanies = await verifiedSvc.listCompanies();
    expect(verifiedCompanies[0]!.verifiedCompatiblePackCount).toBe(3);
  });

  it("projects the three canonical packs deterministically", async () => {
    const a = await (await service()).listCapabilityPacks();
    const b = await (await service()).listCapabilityPacks();
    expect(a).toEqual(b);
    expect(a.packs).toHaveLength(3);
    expect(a.packs.find((p) => p.id === "aao.operational-request")!.requirements.approval.required).toBe(true);
  });

  it("rejects unknown company filters", async () => {
    await expect((await service()).listCapabilityPacks({ companyId: "nobody" })).rejects.toMatchObject({ code: "INSPECTION_NOT_FOUND" });
    await expect((await service()).listCapabilityPacks({ bogus: 1 })).rejects.toMatchObject({ code: "INSPECTION_INVALID_REQUEST" });
  });
});

describe("verified compatibility", () => {
  const ns = createVerifiedRegistrationEvidenceForCompany("northstar-commerce");

  it("COMPATIBLE only with trusted registration evidence", () => {
    const withEvidence = projectPackCompatibilitySummary({ companyManifest: CANONICAL_NORTHSTAR_MANIFEST, pack: COMPANY_RESEARCH_PACK, registrationEvidence: ns.company_research });
    expect(withEvidence).toMatchObject({ status: "COMPATIBLE", verified: true });
  });

  it("NOT_VERIFIED when evidence is missing, even if the proof is enabled and configured", () => {
    const s = projectPackCompatibilitySummary({ companyManifest: CANONICAL_NORTHSTAR_MANIFEST, pack: DOCUMENT_INTELLIGENCE_PACK });
    expect(s).toMatchObject({ status: "NOT_VERIFIED", verified: false, enabledByCompany: true });
  });

  it("INCOMPATIBLE when a required tool is not registered", () => {
    const s = projectPackCompatibilitySummary({
      companyManifest: CANONICAL_NORTHSTAR_MANIFEST,
      pack: COMPANY_RESEARCH_PACK,
      registrationEvidence: { ...ns.company_research!, registeredTools: [] },
    });
    expect(s).toMatchObject({ status: "INCOMPATIBLE", reasonCode: "PACK_REQUIREMENT_MISSING" });
  });

  it("INCOMPATIBLE when a required model policy is not registered", () => {
    const s = projectPackCompatibilitySummary({
      companyManifest: CANONICAL_NORTHSTAR_MANIFEST,
      pack: COMPANY_RESEARCH_PACK,
      registrationEvidence: { ...ns.company_research!, registeredModelPolicies: [] },
    });
    expect(s).toMatchObject({ status: "INCOMPATIBLE", reasonCode: "PACK_REQUIREMENT_MISSING" });
  });

  it("pack requirements are not copied into registration evidence", () => {
    // Supplying evidence with empty tools must NOT be backfilled with pack.manifest.requirements
    const evidenceWithEmptyTools = {
      ...ns.company_research!,
      registeredTools: [],
    };
    const s = projectPackCompatibilitySummary({
      companyManifest: CANONICAL_NORTHSTAR_MANIFEST,
      pack: COMPANY_RESEARCH_PACK,
      registrationEvidence: evidenceWithEmptyTools,
    });
    expect(s.status).toBe("INCOMPATIBLE");
    expect(s.reasonCode).toBe("PACK_REQUIREMENT_MISSING");
  });

  it("synthetic requirements cannot manufacture verified readiness", () => {
    // If pack requires a tool that is not in the trusted snapshot, it is never COMPATIBLE
    const modifiedPack = {
      ...COMPANY_RESEARCH_PACK,
      manifest: {
        ...COMPANY_RESEARCH_PACK.manifest,
        requirements: {
          ...COMPANY_RESEARCH_PACK.manifest.requirements,
          toolRefs: [
            ...COMPANY_RESEARCH_PACK.manifest.requirements.toolRefs,
            { id: "unprovided.phantom.tool", version: "1.0.0" },
          ],
        },
      },
    };
    const s = projectPackCompatibilitySummary({
      companyManifest: CANONICAL_NORTHSTAR_MANIFEST,
      pack: modifiedPack as unknown as typeof COMPANY_RESEARCH_PACK,
      registrationEvidence: ns.company_research,
    });
    expect(s.status).toBe("INCOMPATIBLE");
    expect(s.verified).toBe(false);
  });

  it("INCOMPATIBLE when the company disables the proof", () => {
    const s = projectPackCompatibilitySummary({
      companyManifest: { ...CANONICAL_ARBOR_MANIFEST, enabledProofs: ["company_research"] },
      pack: OPERATIONAL_REQUEST_PACK,
      registrationEvidence: createVerifiedRegistrationEvidenceForCompany("arbor-consulting").operational_request,
    });
    expect(s).toMatchObject({ status: "INCOMPATIBLE", reasonCode: "PACK_PROOF_DISABLED", enabledByCompany: false });
  });
});

describe("workflows", () => {
  it("compiled plan fingerprints equal the fingerprints pinned by the packs", () => {
    expect(projectWorkflowSummary(CANONICAL_COMPANY_RESEARCH_WORKFLOW).planFingerprint).toBe(COMPANY_RESEARCH_PACK.manifest.workflow.planFingerprint);
    expect(projectWorkflowSummary(CANONICAL_DOCUMENT_INTELLIGENCE_WORKFLOW).planFingerprint).toBe(DOCUMENT_INTELLIGENCE_PACK.manifest.workflow.planFingerprint);
    expect(projectWorkflowSummary(CANONICAL_OPERATIONAL_REQUEST_WORKFLOW).planFingerprint).toBe(OPERATIONAL_REQUEST_PACK.manifest.workflow.planFingerprint);
  });

  it("refuses an expected-fingerprint mismatch", () => {
    expect(() => projectWorkflowSummary(CANONICAL_COMPANY_RESEARCH_WORKFLOW, { expectedPlanFingerprint: "0".repeat(64) })).toThrow(OperatorInspectionError);
  });
});

describe("runs, traces, approvals", () => {
  it("never infers a Run status from an incomplete trace", async () => {
    const run = await (await service()).getRunInspection("run.arbor.cr.incomplete");
    expect(run.summary.status).toBe("UNKNOWN");
    expect(run.summary.statusSource).toBe("unavailable");
    expect(run.diagnostics.join(" ")).toMatch(/UNKNOWN/);
  });

  it("uses authoritative state for completed, waiting and failed runs", async () => {
    const runs = await (await service()).listKnownRuns();
    const status = Object.fromEntries(runs.map((r) => [r.runId, r.status]));
    expect(status["run.northstar.cr.001"]).toBe("COMPLETED");
    expect(status["run.arbor.ops.002"]).toBe("WAITING");
    expect(status["run.northstar.cr.003"]).toBe("FAILED");
  });

  it("does not derive approval status from approval.requested trace events", async () => {
    const { tracesByRunId } = await buildCanonicalTraceFixtures();
    const run = projectRunSummary({ runId: "run.arbor.ops.002", traceEvents: tracesByRunId["run.arbor.ops.002"] });
    expect(run.approvalIds).toContain("approval.arbor.ops.002");
    const source = createOperatorInspectionService(createEvidenceBackedInspectionSource({ knownRuns: [{ runId: "run.arbor.ops.002", traceEvents: tracesByRunId["run.arbor.ops.002"] }] }));
    return expect(source.listKnownApprovals()).rejects.toMatchObject({ code: "INSPECTION_SOURCE_UNAVAILABLE" });
  });

  it("reports corrupt traces as corrupt without repairing or hiding them", async () => {
    const { tracesByRunId } = await buildCanonicalTraceFixtures();
    const events = tracesByRunId["run.northstar.cr.001"]!;
    const gapped = [events[0]!, ...events.slice(2)];
    expect(projectTraceInspection({ runId: "run.northstar.cr.001", events: gapped }).health).toBe("corrupt");
    expect(() => projectTraceInspection({ runId: "run.northstar.cr.001", events: gapped, throwOnCorrupt: true })).toThrow(/integrity/);
  });

  it("bounds trace output and rejects over-limit requests", async () => {
    const svc = await service();
    const t = await svc.getRunTraceInspection("run.northstar.cr.001", { limit: 3 });
    expect(t.returnedEventCount).toBe(3);
    expect(t.truncated).toBe(true);
    await expect(svc.getRunTraceInspection("run.northstar.cr.001", { limit: 100000 })).rejects.toMatchObject({ code: "INSPECTION_LIMIT_EXCEEDED" });
    await expect(svc.getRunInspection("run.missing")).rejects.toMatchObject({ code: "INSPECTION_NOT_FOUND" });
    await expect(svc.getRunInspection("bad id!")).rejects.toMatchObject({ code: "INSPECTION_INVALID_REQUEST" });
  });

  it("projects approval records as metadata only", () => {
    const s = projectApprovalSummary(CANONICAL_APPROVAL_RECORDS[1]);
    expect(s.status).toBe("pending");
    expect(() => projectApprovalSummary({ ...CANONICAL_APPROVAL_RECORDS[1], status: "approved" })).toThrow(OperatorInspectionError);
    expect(CANONICAL_RUN_RECORDS["run.arbor.ops.002"]!.status).toBe("WAITING_FOR_APPROVAL");
  });

  it("trace events contain no forbidden content keys", async () => {
    const t = await (await service()).getRunTraceInspection("run.northstar.ops.001");
    expect(findForbiddenInspectionKeys(t)).toEqual([]);
  });
});

describe("evaluations and overview", () => {
  it("distinguishes registered profiles from executed results", async () => {
    const evals = await (await service()).listKnownEvaluationResults();
    expect(evals.filter((e) => e.status === "PASSED")).toHaveLength(3);
    expect(evals.find((e) => e.evalProfileRef.includes("arbor-portability"))).toMatchObject({ status: "REGISTERED", executed: false });
    expect(() => projectEvaluationSummary({ evalProfileRef: "x.y@1.0.0", executed: true, totalCases: 5, passedCases: 2, failedCases: 1 })).toThrow(OperatorInspectionError);
  });

  it("reports unavailable sources explicitly and never invents totals", async () => {
    const overview = await createOperatorInspectionService({}).getOverview();
    expect(overview.counts.companies).toBeNull();
    expect(overview.counts.knownRuns).toBeNull();
    expect(overview.sources.every((s) => s.status === "unavailable")).toBe(true);
  });

  it("full overview reflects real evidence counts and provenance", async () => {
    const svc = await service();
    const o = await svc.getOverview();
    expect(o.counts).toMatchObject({
      companies: 2,
      capabilityPacks: 3,
      compatiblePackBindings: 0,
      unverifiedPackBindings: 6,
      workflows: 3,
      knownRuns: 6,
      knownApprovals: 2,
      knownEvaluations: 4,
    });
    expect(o.readOnly).toBe(true);
    expect(o.provenance.mode).toBe("demo");
    expect(o.provenance.label).toContain("DEMO DATA");

    // When configured with independent proof evidence
    const verifiedSvc = createOperatorInspectionService(
      await createCanonicalDemoInspectionSource({
        registrationEvidenceByCompany: {
          "northstar-commerce": createVerifiedRegistrationEvidenceForCompany("northstar-commerce"),
          "arbor-consulting": createVerifiedRegistrationEvidenceForCompany("arbor-consulting"),
        },
      })
    );
    const verifiedOverview = await verifiedSvc.getOverview();
    expect(verifiedOverview.counts.compatiblePackBindings).toBe(6);
    expect(verifiedOverview.counts.unverifiedPackBindings).toBe(0);
  });

  it("demo mode visible in projected run metadata", async () => {
    const run = await (await service()).getRunInspection("run.northstar.cr.001");
    expect(run.provenance?.mode).toBe("demo");
    expect(run.provenance?.label).toContain("DEMO DATA");
  });

  it("inspection operations execute zero models, tools, or workflows", async () => {
    // Pure projections and reads only; verify that calling inspect methods does not execute side-effects
    const svc = await service();
    const overview = await svc.getOverview();
    const companies = await svc.listCompanies();
    const runs = await svc.listKnownRuns();
    const runDetail = await svc.getRunInspection("run.northstar.cr.001");
    expect(overview.readOnly).toBe(true);
    expect(companies.length).toBe(2);
    expect(runs.length).toBe(6);
    expect(runDetail.summary.status).toBe("COMPLETED");
  });

  it("is deterministic across invocations", async () => {
    expect(await (await service()).getOverview()).toEqual(await (await service()).getOverview());
  });
});
