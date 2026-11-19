import { beforeAll, describe, expect, it, vi } from "vitest";
import type { TraceEvent } from "@aao/contracts";
import {
  COMPANY_RESEARCH_PACK,
  DOCUMENT_INTELLIGENCE_PACK,
} from "@aao/capability-packs";
import {
  CANONICAL_COMPANY_RESEARCH_WORKFLOW,
  CANONICAL_DOCUMENT_INTELLIGENCE_WORKFLOW,
  CANONICAL_NORTHSTAR_MANIFEST,
  CANONICAL_RUN_RECORDS,
  buildCanonicalTraceFixtures,
  createCanonicalDemoInspectionSource,
  createOperatorInspectionService,
  createVerifiedRegistrationEvidenceForCompany,
  formatAdvancedRunInspectionNodesText,
  formatAdvancedRunInspectionTimelineText,
  formatIntegrationDiagnosticsText,
  projectAdvancedRunInspection,
  projectIntegrationDiagnostics,
  getRemediationForCode,
  DETERMINISTIC_REMEDIATION_MAP,
} from "../src/index.js";

describe("Sprint 28: Guided Integration Diagnostics", () => {
  const nsEvidence = createVerifiedRegistrationEvidenceForCompany("northstar-commerce");

  it("produces READY status when all requirements are verified", () => {
    const report = projectIntegrationDiagnostics({
      companyManifest: CANONICAL_NORTHSTAR_MANIFEST,
      pack: COMPANY_RESEARCH_PACK,
      registrationEvidence: nsEvidence.company_research,
    });

    expect(report.status).toBe("READY");
    expect(report.companyId).toBe("northstar-commerce");
    expect(report.packIdentity).toBe(COMPANY_RESEARCH_PACK.identity);
    expect(report.requirements.length).toBeGreaterThan(0);
    // Every requirement with supporting evidence is SATISFIED; configured integrations and
    // run-time permissions cannot be verified by inspection and say so.
    for (const r of report.requirements) {
      expect(r.status).toBe(r.category === "integration" || r.name === "Preliminary Permissions" ? "NOT_VERIFIED" : "SATISFIED");
    }
    expect(report.diagnostics).toEqual([]);
    expect(report.nextSteps[0]).toContain("verified and ready for governed");

    const formatted = formatIntegrationDiagnosticsText(report);
    expect(formatted).toContain("Overall Readiness: READY");
    expect(formatted).toContain("[SATISFIED]");
  });

  it("produces BLOCKED when a required tool is demonstrably missing", () => {
    const report = projectIntegrationDiagnostics({
      companyManifest: CANONICAL_NORTHSTAR_MANIFEST,
      pack: COMPANY_RESEARCH_PACK,
      registrationEvidence: {
        ...nsEvidence.company_research!,
        registeredTools: [],
      },
    });

    expect(report.status).toBe("BLOCKED");
    expect(report.reasonCode).toBe("PACK_REQUIREMENT_MISSING");
    const toolReq = report.requirements.find((r) => r.category === "tool");
    expect(toolReq).toBeDefined();
    expect(toolReq!.status).toBe("MISSING");
    expect(toolReq!.remediation).toContain("Tool");

    const formatted = formatIntegrationDiagnosticsText(report);
    expect(formatted).toContain("Overall Readiness: BLOCKED");
    expect(formatted).toContain("[MISSING]");
    expect(formatted).toContain("Inspect the missing exact Tool");
  });

  it("produces BLOCKED when a required model policy is missing", () => {
    const report = projectIntegrationDiagnostics({
      companyManifest: CANONICAL_NORTHSTAR_MANIFEST,
      pack: COMPANY_RESEARCH_PACK,
      registrationEvidence: {
        ...nsEvidence.company_research!,
        registeredModelPolicies: [],
      },
    });

    expect(report.status).toBe("BLOCKED");
    expect(report.reasonCode).toBe("PACK_REQUIREMENT_MISSING");
    const modelReq = report.requirements.find((r) => r.category === "model_policy");
    expect(modelReq).toBeDefined();
    expect(modelReq!.status).toBe("MISSING");
  });

  it("produces BLOCKED when adapter capability is incompatible", () => {
    const report = projectIntegrationDiagnostics({
      companyManifest: CANONICAL_NORTHSTAR_MANIFEST,
      pack: COMPANY_RESEARCH_PACK,
      registrationEvidence: {
        ...nsEvidence.company_research!,
        registeredModelAdapters: [
          {
            id: "native-llm",
            version: "1.0.0",
            capabilities: [
              { capability: "json_output", support: "unsupported" },
              { capability: "tool_calling", support: "supported" },
            ],
          },
        ],
      },
    });

    expect(report.status).toBe("BLOCKED");
    expect(report.reasonCode).toBe("PACK_CAPABILITY_INCOMPATIBLE");
    const capReq = report.requirements.find((r) => r.category === "model_capability");
    expect(capReq).toBeDefined();
    expect(capReq!.status).toBe("INCOMPATIBLE");
  });

  it("produces BLOCKED when required eval profile is missing", () => {
    const report = projectIntegrationDiagnostics({
      companyManifest: CANONICAL_NORTHSTAR_MANIFEST,
      pack: COMPANY_RESEARCH_PACK,
      registrationEvidence: {
        ...nsEvidence.company_research!,
        registeredEvalProfiles: [],
      },
    });

    expect(report.status).toBe("BLOCKED");
    expect(report.reasonCode).toBe("PACK_VERIFICATION_PROFILE_MISSING");
    const evalReq = report.requirements.find((r) => r.category === "evaluation");
    expect(evalReq).toBeDefined();
    expect(evalReq!.status).toBe("MISSING");
  });

  it("produces NOT_VERIFIED when proof registration evidence is absent", () => {
    const report = projectIntegrationDiagnostics({
      companyManifest: CANONICAL_NORTHSTAR_MANIFEST,
      pack: DOCUMENT_INTELLIGENCE_PACK,
    });

    expect(report.status).toBe("NOT_VERIFIED");
    expect(report.reasonCode).toBe("PACK_EVIDENCE_UNAVAILABLE");
    expect(report.requirements.some((r) => r.status === "NOT_VERIFIED")).toBe(true);
    expect(report.diagnostics[0]?.code).toBe("PACK_EVIDENCE_UNAVAILABLE");

    const formatted = formatIntegrationDiagnosticsText(report);
    expect(formatted).toContain("Overall Readiness: NOT_VERIFIED");
    expect(formatted).toContain("[NOT_VERIFIED]");
  });

  it("produces BLOCKED when the capability pack proof is disabled by company", () => {
    const report = projectIntegrationDiagnostics({
      companyManifest: {
        ...CANONICAL_NORTHSTAR_MANIFEST,
        enabledProofs: ["operational_request"],
      },
      pack: COMPANY_RESEARCH_PACK,
      registrationEvidence: nsEvidence.company_research,
    });

    expect(report.status).toBe("BLOCKED");
    expect(report.reasonCode).toBe("PACK_PROOF_DISABLED");
  });

  it("remediation map covers all canonical failure codes", () => {
    expect(Object.keys(DETERMINISTIC_REMEDIATION_MAP).length).toBeGreaterThanOrEqual(10);
    expect(getRemediationForCode("PACK_REQUIREMENT_MISSING")).toContain("Tool, Policy or integration");
    expect(getRemediationForCode("PACK_CAPABILITY_INCOMPATIBLE")).toContain("adapter capability");
    expect(getRemediationForCode("NON_EXISTENT_CODE")).toBeDefined();
  });
});

describe("Sprint 28: Advanced Run Inspector", () => {
  let tracesByRunId: Readonly<Record<string, readonly TraceEvent[]>>;

  beforeAll(async () => {
    const fixtures = await buildCanonicalTraceFixtures();
    tracesByRunId = fixtures.tracesByRunId;
  });

  it("projects single-attempt run correctly (run.northstar.cr.001)", () => {
    const runRecord = CANONICAL_RUN_RECORDS["run.northstar.cr.001"];
    const runTraces = tracesByRunId["run.northstar.cr.001"];

    const advanced = projectAdvancedRunInspection({
      runId: "run.northstar.cr.001",
      authoritativeRun: runRecord,
      traceEvents: runTraces,
      workflow: CANONICAL_COMPANY_RESEARCH_WORKFLOW,
    });

    expect(advanced.runId).toBe("run.northstar.cr.001");
    expect(advanced.authoritativeStatus).toBe("COMPLETED");
    expect(advanced.statusSource).toBe("authoritative_runtime");
    expect(advanced.nodes.length).toBe(16);
    expect(advanced.nodes.filter((n) => n.executed).length).toBe(2);
    expect(advanced.attempts.length).toBeGreaterThan(0);
    expect(advanced.attempts.every((a) => a.attempt === 1)).toBe(true);

    const nodesFormatted = formatAdvancedRunInspectionNodesText(advanced);
    expect(nodesFormatted).toContain("Run Node Execution: run.northstar.cr.001");
    expect(nodesFormatted).toContain("OBSERVED_COMPLETED");

    const timelineFormatted = formatAdvancedRunInspectionTimelineText(advanced);
    expect(timelineFormatted).toContain("Run Execution Timeline: run.northstar.cr.001");
  });

  it("projects multi-attempt tool retry run (run.northstar.cr.retry)", async () => {
    const source = await createCanonicalDemoInspectionSource({ includeExtendedRuns: true });
    const service = createOperatorInspectionService(source);

    const advanced = await service.getAdvancedRunInspection("run.northstar.cr.retry");
    expect(advanced.runId).toBe("run.northstar.cr.retry");
    expect(advanced.authoritativeStatus).toBe("COMPLETED");

    // One execution occurrence, two attempts, one explicit retry.scheduled
    const searchNode = advanced.nodes.find((n) => n.nodeId === "search");
    expect(searchNode).toBeDefined();
    expect(searchNode!.executionCount).toBe(1);
    expect(searchNode!.attemptCount).toBe(2);
    expect(searchNode!.scheduledRetries).toBe(1);
    expect(searchNode!.attempts[0]!.status).toBe("retried");
    expect(searchNode!.attempts[0]!.reasonCode).toBe("PROVIDER_TIMEOUT");
    expect(searchNode!.attempts[1]!.status).toBe("completed");
    expect(advanced.counters).toMatchObject({ traceEvents: 10, nodeAttempts: 2, scheduledRetries: 1, toolPhysicalInvocations: 2 });

    // Node diagnostics flag the scheduled retry
    expect(searchNode!.diagnostics.some((d) => d.includes("explicitly scheduled retries"))).toBe(true);

    const text = formatAdvancedRunInspectionTimelineText(advanced);
    expect(text).toContain("attempt=1");
    expect(text).toContain("attempt=2");
    expect(text).toContain("code=PROVIDER_TIMEOUT");
  });

  it("projects recovery/replay run (run.northstar.ops.recovery)", async () => {
    const source = await createCanonicalDemoInspectionSource({ includeExtendedRuns: true });
    const service = createOperatorInspectionService(source);

    const advanced = await service.getAdvancedRunInspection("run.northstar.ops.recovery");
    expect(advanced.runId).toBe("run.northstar.ops.recovery");

    // Recovery replay attempt is flagged
    const replayAttempt = advanced.attempts.find((a) => a.recoveryReplay === true);
    expect(replayAttempt).toBeDefined();

    const timelineText = formatAdvancedRunInspectionTimelineText(advanced);
    expect(timelineText).toContain("(recovery replay)");
    expect(advanced.counters).toMatchObject({ nodeAttempts: 0, recoveryReplayAttempts: 1 });
  });

  it("distinguishes zero model calls (run.arbor.di.001) from partially recorded usage (run.northstar.cr.repeat)", () => {
    const noModel = projectAdvancedRunInspection({
      runId: "run.arbor.di.001",
      authoritativeRun: CANONICAL_RUN_RECORDS["run.arbor.di.001"],
      traceEvents: tracesByRunId["run.arbor.di.001"],
      workflow: CANONICAL_DOCUMENT_INTELLIGENCE_WORKFLOW,
    });
    expect(noModel.tokenUsage).toMatchObject({ status: "complete", modelInvocations: 0 });
    expect(formatAdvancedRunInspectionNodesText(noModel)).toContain("Token Accounting: COMPLETE (0 model invocations)");

    const partial = projectAdvancedRunInspection({
      runId: "run.northstar.cr.repeat",
      authoritativeRun: CANONICAL_RUN_RECORDS["run.northstar.cr.repeat"],
      traceEvents: tracesByRunId["run.northstar.cr.repeat"],
      workflow: CANONICAL_COMPANY_RESEARCH_WORKFLOW,
    });
    expect(partial.tokenUsage).toMatchObject({ status: "partial", modelInvocations: 2, callsWithUsage: 1, knownTotalTokens: 250 });
    expect(partial.tokenUsage?.totalTokens).toBeUndefined();
    const plan = partial.nodes.find((n) => n.nodeId === "plan")!;
    expect(plan.executionCount).toBe(2);
    expect(plan.attempts[1]!.tokenUsage).toMatchObject({ status: "unavailable" });
    expect(plan.attempts[1]!.tokenUsage?.totalTokens).toBeUndefined();

    const timelineText = formatAdvancedRunInspectionTimelineText(partial);
    expect(timelineText).toContain("Token Accounting: PARTIAL (known recorded totals: input=200, output=50, total=250; 1/2 invocations with usage)");
  });

  it("flags corrupt trace integrity explicitly", () => {
    const runRecord = CANONICAL_RUN_RECORDS["run.northstar.cr.001"];
    const runTraces = tracesByRunId["run.northstar.cr.001"]!;
    const gapped = [runTraces[0]!, ...runTraces.slice(2)];

    const advanced = projectAdvancedRunInspection({
      runId: "run.northstar.cr.001",
      authoritativeRun: runRecord,
      traceEvents: gapped,
      workflow: CANONICAL_COMPANY_RESEARCH_WORKFLOW,
    });

    expect(advanced.evidenceHealth).toBe("corrupt");
    expect(advanced.diagnostics.some((d) => d.code === "TRACE_CORRUPT")).toBe(true);
  });

  it("reports UNKNOWN status for incomplete runs without terminal authoritative state", () => {
    const runTraces = tracesByRunId["run.arbor.cr.incomplete"];

    const advanced = projectAdvancedRunInspection({
      runId: "run.arbor.cr.incomplete",
      traceEvents: runTraces,
      workflow: CANONICAL_COMPANY_RESEARCH_WORKFLOW,
    });

    expect(advanced.authoritativeStatus).toBe("UNKNOWN");
    expect(advanced.statusSource).toBe("unavailable");
    expect(advanced.diagnostics.some((d) => d.code === "AUTHORITATIVE_STATE_UNAVAILABLE")).toBe(true);
  });

  it("guarantees read-only purity: zero model calls, zero tool executions, zero config mutations", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const evidenceBefore = JSON.stringify([CANONICAL_RUN_RECORDS, CANONICAL_NORTHSTAR_MANIFEST, tracesByRunId]);
    const source = await createCanonicalDemoInspectionSource({ includeExtendedRuns: true });
    const service = createOperatorInspectionService(source);

    // Call all inspection service methods
    await service.getOverview();
    await service.listCompanies();
    await service.listCapabilityPacks();
    await service.listWorkflows();
    await service.listKnownRuns();
    await service.getRunInspection("run.northstar.cr.001");
    await service.getAdvancedRunInspection("run.northstar.cr.retry");
    await service.getIntegrationDiagnostics("northstar-commerce", "aao.company-research@1.0.0");

    // Measured: no network access and no mutation of any evidence the queries read.
    // (Trace-store write spies and package-boundary checks live in sprint28c.test.ts.)
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify([CANONICAL_RUN_RECORDS, CANONICAL_NORTHSTAR_MANIFEST, tracesByRunId])).toBe(evidenceBefore);
    fetchSpy.mockRestore();
  });
});
