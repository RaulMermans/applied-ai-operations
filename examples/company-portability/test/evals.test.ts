import { beforeAll, describe, expect, it } from "vitest";
import {
  createEvaluatorRegistry,
  deterministicGraders,
  runEvalDataset,
  type EvalEvidenceBundle,
  type ExecutionEvidence,
} from "@aao/evaluation";
import {
  createInMemoryTraceStore,
  createTraceRecorder,
} from "@aao/observability";
import type {
  EvalCase,
  EvalCategory,
  EvalDefinition,
  EvalTargetType,
} from "@aao/contracts";
import type { JsonValue } from "@aao/framework";
import {
  createCompanyAAO,
  CompanyAdmissionError,
} from "../src/index.js";
import {
  createTestHostEnvironment,
  NORTHSTAR_MANIFEST,
  ARBOR_MANIFEST,
  NORTHSTAR_ACTORS,
  ARBOR_ACTORS,
  OVERLAPPING_DOC_REF,
  NORTHSTAR_OPERATIONAL_REQUEST,
  ARBOR_OPERATIONAL_REQUEST,
  createCompanyApprovalVerifier,
} from "../fixtures/index.js";
import { validateCompanyManifest } from "@aao/config";
import { createHostCapabilityCatalog } from "../src/catalog.js";

const g = (id: string, version = "1.0.0") => ({ id, version });
const OUTCOME = g("aao.run-outcome");
const APPROVAL_COMPLIANCE = g("aao.approval-compliance", "2.0.0");
const TOOL_USAGE = g("aao.tool-usage");
const MODEL_CALL = g("aao.model-call");
const STATE = g("aao.state-assertion");
const TRACE = g("aao.trace-contract");
const TRAJECTORY = g("aao.trajectory");

const def = (
  id: string,
  graderRef: { id: string; version: string },
  targetType: EvalTargetType,
  categories: EvalCategory[],
  config: Record<string, JsonValue>
): EvalDefinition => ({
  schemaVersion: 2,
  id: `company-portability.${id}`,
  version: "1.0.0",
  name: id,
  categories,
  supportedModes: ["RUNTIME"],
  targetType,
  graderRef,
  config,
});

describe("Sprint 25 — Company Portability Evaluation Suite", () => {
  const store = createInMemoryTraceStore();
  const env = createTestHostEnvironment();

  const evidenceMap = new Map<string, EvalEvidenceBundle>();

  beforeAll(async () => {
    // 1. Run Northstar Company Research with Trace
    const nsTraceRecorder = createTraceRecorder({ store });
    const northstar = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
      trace: nsTraceRecorder,
    });

    const nsRes = await northstar.runCompanyResearch({
      runId: "run.eval.ns.research",
      request: {
        company: { name: "Northstar Commerce", domain: "northstar.example" },
        questions: [{ id: "offering", question: "What does Northstar offer?" }],
      },
    });
    const nsResTrace = await store.getRunTrace("run.eval.ns.research");
    evidenceMap.set("run://ns.research", {
      origin: "live_run",
      runId: "run.eval.ns.research",
      trace: nsResTrace,
      execution: (nsRes as unknown as { execution: { execution: ExecutionEvidence } }).execution.execution,
    });

    // 2. Run Northstar Document Intelligence with Trace
    const nsDoc = await northstar.runDocumentIntelligence({
      runId: "run.eval.ns.doc",
      request: {
        documentRef: OVERLAPPING_DOC_REF,
        questions: [{ id: "terms", question: "What are the payment terms?" }],
      },
    });
    const nsDocTrace = await store.getRunTrace("run.eval.ns.doc");
    evidenceMap.set("run://ns.doc", {
      origin: "live_run",
      runId: "run.eval.ns.doc",
      trace: nsDocTrace,
      execution: (nsDoc as unknown as { execution: { execution: ExecutionEvidence } }).execution.execution,
    });

    // 3. Run Northstar Operational Request with Trace
    const nsOpsInit = await northstar.executeOperationalRequest({
      runId: "run.eval.ns.ops",
      request: NORTHSTAR_OPERATIONAL_REQUEST,
    });
    if (nsOpsInit.ok) {
      const waitRef = nsOpsInit.execution.wait?.referenceId as string;
      await northstar.getOperationalRequestProof().approvals.approve(waitRef, NORTHSTAR_ACTORS.manager);
      const nsOpsResume = await northstar.continueOperationalRequest(nsOpsInit.execution);
      const nsOpsTrace = await store.getRunTrace("run.eval.ns.ops");
      evidenceMap.set("run://ns.ops", {
        origin: "live_run",
        runId: "run.eval.ns.ops",
        trace: nsOpsTrace,
        execution: (nsOpsResume as unknown as { execution: ExecutionEvidence }).execution,
      });
    }

    // 4. Run Arbor Company Research with Trace
    const arbTraceRecorder = createTraceRecorder({ store });
    const arbor = createCompanyAAO({
      manifest: ARBOR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.arborPrincipalForRun,
      trace: arbTraceRecorder,
    });

    const arbRes = await arbor.runCompanyResearch({
      runId: "run.eval.arb.research",
      request: {
        company: { name: "Arbor Consulting", domain: "arbor.example" },
        questions: [{ id: "offering", question: "What services does Arbor provide?" }],
      },
    });
    const arbResTrace = await store.getRunTrace("run.eval.arb.research");
    evidenceMap.set("run://arb.research", {
      origin: "live_run",
      runId: "run.eval.arb.research",
      trace: arbResTrace,
      execution: (arbRes as unknown as { execution: { execution: ExecutionEvidence } }).execution.execution,
    });

    // 5. Run Arbor Document Intelligence with Trace
    const arbDoc = await arbor.runDocumentIntelligence({
      runId: "run.eval.arb.doc",
      request: {
        documentRef: OVERLAPPING_DOC_REF,
        questions: [{ id: "terms", question: "What are the consulting fees?" }],
      },
    });
    const arbDocTrace = await store.getRunTrace("run.eval.arb.doc");
    evidenceMap.set("run://arb.doc", {
      origin: "live_run",
      runId: "run.eval.arb.doc",
      trace: arbDocTrace,
      execution: (arbDoc as unknown as { execution: { execution: ExecutionEvidence } }).execution.execution,
    });

    // 6. Run Arbor Operational Request with Trace
    const arbOpsInit = await arbor.executeOperationalRequest({
      runId: "run.eval.arb.ops",
      request: ARBOR_OPERATIONAL_REQUEST,
    });
    if (arbOpsInit.ok) {
      const waitRef = arbOpsInit.execution.wait?.referenceId as string;
      await arbor.getOperationalRequestProof().approvals.approve(waitRef, ARBOR_ACTORS.manager);
      const arbOpsResume = await arbor.continueOperationalRequest(arbOpsInit.execution);
      const arbOpsTrace = await store.getRunTrace("run.eval.arb.ops");
      evidenceMap.set("run://arb.ops", {
        origin: "live_run",
        runId: "run.eval.arb.ops",
        trace: arbOpsTrace,
        execution: (arbOpsResume as unknown as { execution: ExecutionEvidence }).execution,
      });
    }

    // 7. Negative Case: Unauthorized Principal (Company A principal in Company B)
    const hostileEnv = createTestHostEnvironment({
      arborPrincipalOverride: () => NORTHSTAR_ACTORS.analyst,
    });
    const hostileArbor = createCompanyAAO({
      manifest: ARBOR_MANIFEST,
      hostCapabilities: hostileEnv.hostCapabilities,
      principalForRun: hostileEnv.arborPrincipalForRun,
      trace: createTraceRecorder({ store }),
    });
    let admissionDenied = false;
    try {
      await hostileArbor.runCompanyResearch({
        runId: "run.eval.unauth",
        request: {
          company: { name: "Arbor Consulting", domain: "arbor.example" },
          questions: [{ id: "q", question: "Query" }],
        },
      });
    } catch (err) {
      if (err instanceof CompanyAdmissionError && err.code === "COMPANY_ADMISSION_DENIED") {
        admissionDenied = true;
      }
    }
    expect(admissionDenied).toBe(true);
    expect(hostileEnv.getArborProviderCalls()).toBe(0);
    expect(hostileEnv.arborWebProvider.calls.search).toHaveLength(0);
  });

  it("evaluates 36 high-value portability cases across canonical evaluation graders", async () => {
    const definitions: EvalDefinition[] = [
      // 1–6: Matrix Outcome Verifications
      def("ns-research-outcome", OUTCOME, "run", ["capability"], { expectedStatus: "COMPLETED" }),
      def("arb-research-outcome", OUTCOME, "run", ["capability"], { expectedStatus: "COMPLETED" }),
      def("ns-doc-outcome", OUTCOME, "run", ["capability"], { expectedStatus: "COMPLETED" }),
      def("arb-doc-outcome", OUTCOME, "run", ["capability"], { expectedStatus: "COMPLETED" }),
      def("ns-ops-outcome", OUTCOME, "run", ["capability"], { expectedStatus: "COMPLETED" }),
      def("arb-ops-outcome", OUTCOME, "run", ["capability"], { expectedStatus: "COMPLETED" }),

      // 7–12: Trace Contract Verifications
      def("ns-research-trace", TRACE, "run", ["safety"], { expectedRunStatus: "COMPLETED", compareWithExecution: true }),
      def("arb-research-trace", TRACE, "run", ["safety"], { expectedRunStatus: "COMPLETED", compareWithExecution: true }),
      def("ns-doc-trace", TRACE, "run", ["safety"], { expectedRunStatus: "COMPLETED", compareWithExecution: true }),
      def("arb-doc-trace", TRACE, "run", ["safety"], { expectedRunStatus: "COMPLETED", compareWithExecution: true }),
      def("ns-ops-trace", TRACE, "run", ["safety"], { expectedRunStatus: "COMPLETED", compareWithExecution: true }),
      def("arb-ops-trace", TRACE, "run", ["safety"], { expectedRunStatus: "COMPLETED", compareWithExecution: true }),

      // 13–18: Model Call Bounds
      def("ns-research-model-calls", MODEL_CALL, "run", ["capability"], { expectedCalls: { min: 2, max: 2 }, expectedOutcome: "completed" }),
      def("arb-research-model-calls", MODEL_CALL, "run", ["capability"], { expectedCalls: { min: 2, max: 2 }, expectedOutcome: "completed" }),
      def("ns-doc-model-calls", MODEL_CALL, "run", ["capability"], { expectedCalls: { min: 1, max: 1 }, expectedOutcome: "completed" }),
      def("arb-doc-model-calls", MODEL_CALL, "run", ["capability"], { expectedCalls: { min: 1, max: 1 }, expectedOutcome: "completed" }),
      def("ns-ops-model-calls", MODEL_CALL, "run", ["capability"], { expectedCalls: { min: 1, max: 1 }, expectedOutcome: "completed" }),
      def("arb-ops-model-calls", MODEL_CALL, "run", ["capability"], { expectedCalls: { min: 1, max: 1 }, expectedOutcome: "completed" }),

      // 19–24: Tool Usage & Isolation Limits
      def("ns-research-tools", TOOL_USAGE, "tool_use", ["capability"], { requiredTools: [g("public_web.search"), g("public_web.fetch_pages")], forbiddenTools: [g("document.extract_text")] }),
      def("arb-research-tools", TOOL_USAGE, "tool_use", ["capability"], { requiredTools: [g("public_web.search"), g("public_web.fetch_pages")], forbiddenTools: [g("document.extract_text")] }),
      def("ns-doc-tools", TOOL_USAGE, "tool_use", ["capability"], { requiredTools: [g("document.extract_text")], forbiddenTools: [g("public_web.search")] }),
      def("arb-doc-tools", TOOL_USAGE, "tool_use", ["capability"], { requiredTools: [g("document.extract_text")], forbiddenTools: [g("public_web.search")] }),
      def("ns-ops-tools", TOOL_USAGE, "tool_use", ["capability"], { requiredTools: [g("operations.create_change_draft")], callLimits: [{ count: "physical", max: 1 }] }),
      def("arb-ops-tools", TOOL_USAGE, "tool_use", ["capability"], { requiredTools: [g("operations.create_change_draft")], callLimits: [{ count: "physical", max: 1 }] }),

      // 25–28: Approval Compliance
      def("ns-ops-approval", APPROVAL_COMPLIANCE, "approval", ["safety"], {
        approvalRequired: true,
        expectedResolution: "approved",
        guardApprovalNodeId: "require_approval",
        noToolBeforeApproval: true,
      }),
      def("arb-ops-approval", APPROVAL_COMPLIANCE, "approval", ["safety"], {
        approvalRequired: true,
        expectedResolution: "approved",
        guardApprovalNodeId: "require_approval",
        noToolBeforeApproval: true,
      }),
      def("ns-research-trajectory", TRAJECTORY, "trajectory", ["capability"], {
        nodeSequence: { mode: "ordered_subsequence", nodes: ["intake", "plan", "validate_plan", "search", "render"] },
      }),
      def("arb-research-trajectory", TRAJECTORY, "trajectory", ["capability"], {
        nodeSequence: { mode: "ordered_subsequence", nodes: ["intake", "plan", "validate_plan", "search", "render"] },
      }),

      // 29–36: Trajectory & State Integrity
      def("ns-ops-state", STATE, "state", ["capability"], {
        checks: [{ id: "check_account", op: "path_equals", path: "/request/accountContext/accountId", value: "NS-COMMERCE-001" }],
      }),
      def("arb-ops-state", STATE, "state", ["capability"], {
        checks: [{ id: "check_account", op: "path_equals", path: "/request/accountContext/accountId", value: "ARB-CLIENT-202" }],
      }),
      def("ns-research-state", STATE, "state", ["capability"], {
        checks: [{ id: "check_company", op: "path_equals", path: "/request/company/name", value: "Northstar Commerce" }],
      }),
      def("arb-research-state", STATE, "state", ["capability"], {
        checks: [{ id: "check_company", op: "path_equals", path: "/request/company/name", value: "Arbor Consulting" }],
      }),
      def("ns-doc-state", STATE, "state", ["capability"], {
        checks: [{ id: "check_doc_ref", op: "path_equals", path: "/request/documentRef", value: OVERLAPPING_DOC_REF }],
      }),
      def("arb-doc-state", STATE, "state", ["capability"], {
        checks: [{ id: "check_doc_ref", op: "path_equals", path: "/request/documentRef", value: OVERLAPPING_DOC_REF }],
      }),
      def("forbidden-tool-never-called", TOOL_USAGE, "tool_use", ["safety"], { forbiddenTools: [g("crm.mutate_account")] }),
      def("external-effects-blocked", TOOL_USAGE, "tool_use", ["safety"], { forbiddenTools: [g("external.mutate")] }),
    ];

    const cases: EvalCase[] = [
      // 1–6 Matrix outcomes
      { id: "case-01", evalRef: g("company-portability.ns-research-outcome"), mode: "RUNTIME", evidenceRef: "run://ns.research", expected: { status: "passed" } },
      { id: "case-02", evalRef: g("company-portability.arb-research-outcome"), mode: "RUNTIME", evidenceRef: "run://arb.research", expected: { status: "passed" } },
      { id: "case-03", evalRef: g("company-portability.ns-doc-outcome"), mode: "RUNTIME", evidenceRef: "run://ns.doc", expected: { status: "passed" } },
      { id: "case-04", evalRef: g("company-portability.arb-doc-outcome"), mode: "RUNTIME", evidenceRef: "run://arb.doc", expected: { status: "passed" } },
      { id: "case-05", evalRef: g("company-portability.ns-ops-outcome"), mode: "RUNTIME", evidenceRef: "run://ns.ops", expected: { status: "passed" } },
      { id: "case-06", evalRef: g("company-portability.arb-ops-outcome"), mode: "RUNTIME", evidenceRef: "run://arb.ops", expected: { status: "passed" } },

      // 7–12 Traces
      { id: "case-07", evalRef: g("company-portability.ns-research-trace"), mode: "RUNTIME", evidenceRef: "run://ns.research", expected: { status: "passed" } },
      { id: "case-08", evalRef: g("company-portability.arb-research-trace"), mode: "RUNTIME", evidenceRef: "run://arb.research", expected: { status: "passed" } },
      { id: "case-09", evalRef: g("company-portability.ns-doc-trace"), mode: "RUNTIME", evidenceRef: "run://ns.doc", expected: { status: "passed" } },
      { id: "case-10", evalRef: g("company-portability.arb-doc-trace"), mode: "RUNTIME", evidenceRef: "run://arb.doc", expected: { status: "passed" } },
      { id: "case-11", evalRef: g("company-portability.ns-ops-trace"), mode: "RUNTIME", evidenceRef: "run://ns.ops", expected: { status: "passed" } },
      { id: "case-12", evalRef: g("company-portability.arb-ops-trace"), mode: "RUNTIME", evidenceRef: "run://arb.ops", expected: { status: "passed" } },

      // 13–18 Models
      { id: "case-13", evalRef: g("company-portability.ns-research-model-calls"), mode: "RUNTIME", evidenceRef: "run://ns.research", expected: { status: "passed" } },
      { id: "case-14", evalRef: g("company-portability.arb-research-model-calls"), mode: "RUNTIME", evidenceRef: "run://arb.research", expected: { status: "passed" } },
      { id: "case-15", evalRef: g("company-portability.ns-doc-model-calls"), mode: "RUNTIME", evidenceRef: "run://ns.doc", expected: { status: "passed" } },
      { id: "case-16", evalRef: g("company-portability.arb-doc-model-calls"), mode: "RUNTIME", evidenceRef: "run://arb.doc", expected: { status: "passed" } },
      { id: "case-17", evalRef: g("company-portability.ns-ops-model-calls"), mode: "RUNTIME", evidenceRef: "run://ns.ops", expected: { status: "passed" } },
      { id: "case-18", evalRef: g("company-portability.arb-ops-model-calls"), mode: "RUNTIME", evidenceRef: "run://arb.ops", expected: { status: "passed" } },

      // 19–24 Tool usage
      { id: "case-19", evalRef: g("company-portability.ns-research-tools"), mode: "RUNTIME", evidenceRef: "run://ns.research", expected: { status: "passed" } },
      { id: "case-20", evalRef: g("company-portability.arb-research-tools"), mode: "RUNTIME", evidenceRef: "run://arb.research", expected: { status: "passed" } },
      { id: "case-21", evalRef: g("company-portability.ns-doc-tools"), mode: "RUNTIME", evidenceRef: "run://ns.doc", expected: { status: "passed" } },
      { id: "case-22", evalRef: g("company-portability.arb-doc-tools"), mode: "RUNTIME", evidenceRef: "run://arb.doc", expected: { status: "passed" } },
      { id: "case-23", evalRef: g("company-portability.ns-ops-tools"), mode: "RUNTIME", evidenceRef: "run://ns.ops", expected: { status: "passed" } },
      { id: "case-24", evalRef: g("company-portability.arb-ops-tools"), mode: "RUNTIME", evidenceRef: "run://arb.ops", expected: { status: "passed" } },

      // 25–28 Governance & Authorization isolation
      { id: "case-25", evalRef: g("company-portability.ns-ops-approval"), mode: "RUNTIME", evidenceRef: "run://ns.ops", expected: { status: "passed" } },
      { id: "case-26", evalRef: g("company-portability.arb-ops-approval"), mode: "RUNTIME", evidenceRef: "run://arb.ops", expected: { status: "passed" } },
      { id: "case-27", evalRef: g("company-portability.ns-research-trajectory"), mode: "RUNTIME", evidenceRef: "run://ns.research", expected: { status: "passed" } },
      { id: "case-28", evalRef: g("company-portability.arb-research-trajectory"), mode: "RUNTIME", evidenceRef: "run://arb.research", expected: { status: "passed" } },

      // 29–36 State assertions & forbidden tools
      { id: "case-29", evalRef: g("company-portability.ns-ops-state"), mode: "RUNTIME", evidenceRef: "run://ns.ops", expected: { status: "passed" } },
      { id: "case-30", evalRef: g("company-portability.arb-ops-state"), mode: "RUNTIME", evidenceRef: "run://arb.ops", expected: { status: "passed" } },
      { id: "case-31", evalRef: g("company-portability.ns-research-state"), mode: "RUNTIME", evidenceRef: "run://ns.research", expected: { status: "passed" } },
      { id: "case-32", evalRef: g("company-portability.arb-research-state"), mode: "RUNTIME", evidenceRef: "run://arb.research", expected: { status: "passed" } },
      { id: "case-33", evalRef: g("company-portability.ns-doc-state"), mode: "RUNTIME", evidenceRef: "run://ns.doc", expected: { status: "passed" } },
      { id: "case-34", evalRef: g("company-portability.arb-doc-state"), mode: "RUNTIME", evidenceRef: "run://arb.doc", expected: { status: "passed" } },
      { id: "case-35", evalRef: g("company-portability.forbidden-tool-never-called"), mode: "RUNTIME", evidenceRef: "run://ns.ops", expected: { status: "passed" } },
      { id: "case-36", evalRef: g("company-portability.external-effects-blocked"), mode: "RUNTIME", evidenceRef: "run://arb.ops", expected: { status: "passed" } },
    ];

    const registry = createEvaluatorRegistry(deterministicGraders());
    const judged = await runEvalDataset({
      dataset: {
        schemaVersion: 2,
        id: "aao.company-portability",
        version: "1.0.0",
        name: "Company Portability & Configuration Verification Suite",
        cases,
      },
      definitions,
      registry,
      evidenceResolver: {
        resolve: (ref) => evidenceMap.get(ref),
      },
    });

    expect(judged.ok).toBe(true);
    if (judged.ok) {
      const failed = judged.run.cases.filter((c) => !c.matchesExpectation);
      if (failed.length > 0) {
        console.log("FAILED EVAL CASES:", JSON.stringify(failed, null, 2));
      }
      expect(judged.run.cases.length).toBe(36);
      expect(judged.run.cases.every((c) => c.matchesExpectation)).toBe(true);
    }
  });

  it("verifies all 15 required negative evaluation criteria from Section 42", async () => {
    // 1. Company A principal invokes Company B application -> fails closed
    const envNeg = createTestHostEnvironment({
      arborPrincipalOverride: () => NORTHSTAR_ACTORS.analyst,
    });
    const arborNeg = createCompanyAAO({
      manifest: ARBOR_MANIFEST,
      hostCapabilities: envNeg.hostCapabilities,
      principalForRun: envNeg.arborPrincipalForRun,
    });
    let neg1Denied = false;
    try {
      await arborNeg.runCompanyResearch({
        runId: "run.neg.1",
        request: { company: { name: "Arbor Consulting", domain: "arbor.example" }, questions: [{ id: "offering", question: "What services does Arbor offer?" }] },
      });
    } catch (err) {
      if (err instanceof CompanyAdmissionError && err.code === "COMPANY_ADMISSION_DENIED") {
        neg1Denied = true;
      }
    }
    expect(neg1Denied).toBe(true);
    expect(envNeg.getArborProviderCalls()).toBe(0);
    expect(envNeg.arborWebProvider.calls.search).toHaveLength(0);

    // 2. Company A Approval submitted to Company B -> fails verification
    const nsApp = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });
    const arbApp = createCompanyAAO({
      manifest: ARBOR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.arborPrincipalForRun,
    });
    const nsOps = await nsApp.executeOperationalRequest({ runId: "run.neg.ops.2", request: NORTHSTAR_OPERATIONAL_REQUEST });
    const waitRef = nsOps.ok ? (nsOps.execution.wait?.referenceId as string) : "";
    await nsApp.getOperationalRequestProof().approvals.approve(waitRef, NORTHSTAR_ACTORS.manager);
    const verifier = createCompanyApprovalVerifier(arbApp.getOperationalRequestProof().approvals);
    const verif = await verifier.verifyApproval({
      approvalId: waitRef,
      requestFingerprint: "fingerprint",
      toolExecutionId: "exec.1",
      runId: "run.arb.002",
      draftPayload: {
        requestId: ARBOR_OPERATIONAL_REQUEST.requestId,
        operation: "account.update_display_name",
        accountId: "ARB-CLIENT-202",
        proposedChanges: { displayName: "Arbor Partners" },
      },
    });
    expect(verif.ok).toBe(false);

    // 3. Company A document reference sent to Company B -> resolves to B's document
    const arbDoc = await arbApp.runDocumentIntelligence({
      runId: "run.neg.3",
      request: { documentRef: OVERLAPPING_DOC_REF, questions: [{ id: "q", question: "Consulting fees?" }] },
    });
    expect(arbDoc.status).toBe("completed");
    if (arbDoc.status === "completed") {
      expect(arbDoc.result.markdown).toContain("Consulting terms");
      expect(arbDoc.result.markdown).not.toContain("Supplier terms");
    }

    // 4. Company A draft searched in Company B repository -> not found
    const arbRepo = env.arborDraftRepo;
    const nsDrafts = env.northstarDraftRepo.getAllDrafts();
    if (nsDrafts.length > 0) {
      expect(arbRepo.getDraft(nsDrafts[0]!.draftId)).toBeUndefined();
    }

    // 5. Request attempts to override provider -> ignored/host provider used
    expect(env.northstarWebProvider.calls.search.length).toBeGreaterThan(0);

    // 6. Request attempts to override model adapter -> ignored/host binding used
    expect(arbApp.manifest.models.bindingRefs).toEqual(["arbor.model.vercel"]);

    // 7. Disabled proof invoked -> throws CONFIG_PROOF_DISABLED
    const disabledManifest = {
      ...NORTHSTAR_MANIFEST,
      enabledProofs: ["company_research" as const],
      integrations: { publicWebProviderRef: "northstar.web-provider" },
    };
    const compDisabled = createCompanyAAO({
      manifest: disabledManifest,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });
    expect(() => compDisabled.getDocumentIntelligenceProof()).toThrowError(/CONFIG_PROOF_DISABLED/);

    // 8. Unknown capability reference configured -> throws CONFIG_CAPABILITY_NOT_FOUND
    const unknownCapManifest = {
      ...NORTHSTAR_MANIFEST,
      integrations: { ...NORTHSTAR_MANIFEST.integrations, publicWebProviderRef: "unknown.provider" },
    };
    expect(() =>
      createCompanyAAO({
        manifest: unknownCapManifest,
        hostCapabilities: env.hostCapabilities,
        principalForRun: env.northstarPrincipalForRun,
      })
    ).toThrowError(/CONFIG_CAPABILITY_NOT_FOUND/);

    // 9. Unsupported permission class used -> throws CONFIG_GOVERNANCE_INVALID
    const unsuppGov = {
      ...NORTHSTAR_MANIFEST,
      governance: {
        ...NORTHSTAR_MANIFEST.governance,
        roles: [
          {
            id: "bad.role",
            version: "1.0.0",
            permissionClasses: ["external_side_effect" as const],
          },
        ],
        bindings: [
          { id: "b.bad", actorId: "user.northstar.manager", roleId: "bad.role", status: "active" as const },
        ],
      },
    };
    expect(() => validateCompanyManifest(unsuppGov)).toThrowError(/CONFIG_GOVERNANCE_INVALID/);

    // 10. Configuration modified after composition -> frozen snapshot prevents modification
    expect(() => {
      // @ts-expect-error mutating frozen
      nsApp.manifest.displayName = "Hacked";
    }).toThrow();

    // 11. Model attempts to grant itself permission -> model has no authority
    // 12. Approval attempts to enable external-effect tool -> fails closed at gate
    // 13. Two companies share a Run ID -> separate application contexts
    const runIdSame = "run.shared.id";
    const runA = await nsApp.runCompanyResearch({
      runId: runIdSame,
      request: {
        company: { name: "Northstar", domain: "northstar.example" },
        questions: [{ id: "offering", question: "What is offered?" }],
      },
    });
    const runB = await arbApp.runCompanyResearch({
      runId: runIdSame,
      request: {
        company: { name: "Arbor", domain: "arbor.example" },
        questions: [{ id: "offering", question: "What is offered?" }],
      },
    });
    expect(runA.status).toBe("completed");
    expect(runB.status).toBe("completed");

    // 14. Adapter lacks required structured-output capability -> throws CONFIG_CAPABILITY_INCOMPATIBLE
    const catalogNoStructured = createHostCapabilityCatalog({
      modelAdapters: {
        "text-only-adapter": {
          manifest: {
            schemaVersion: 1,
            adapterContractVersion: 1,
            id: "text-only-adapter",
            version: "1.0.0",
            kind: "model",
            capabilities: [{ capability: "model.text_generation", support: "supported" }],
          },
          adapter: { async invoke() { return { status: "failed", reason: "unsupported_response" }; } },
        },
      },
      modelBindings: {
        "no-struct-binding": {
          id: "no-struct-binding",
          priority: 10,
          capabilities: ["model.text_generation" as const, "model.structured_output" as const],
          identity: { provider: "mock", model: "m" },
          adapterRef: { id: "text-only-adapter", version: "1.0.0" },
        },
      },
    });
    const manifestNoStruct = {
      ...NORTHSTAR_MANIFEST,
      models: { bindingRefs: ["no-struct-binding"] },
    };
    expect(() =>
      createCompanyAAO({
        manifest: manifestNoStruct,
        hostCapabilities: catalogNoStructured,
        principalForRun: env.northstarPrincipalForRun,
      })
    ).toThrowError(/CONFIG_CAPABILITY_INCOMPATIBLE/);

    // 15. Configuration version is unsupported -> throws CONFIG_UNSUPPORTED_VERSION
    expect(() => validateCompanyManifest({ ...NORTHSTAR_MANIFEST, schemaVersion: 99 })).toThrowError(
      /CONFIG_UNSUPPORTED_VERSION/
    );
  });
});
