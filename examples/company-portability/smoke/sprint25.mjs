// Sprint 25 compiled smoke: Company Configuration & Portability proof using compiled package output only.
// Runs after `pnpm build`. Every AAO import resolves through package exports / dist.
// No network, external API keys, or external databases.

import process from "node:process";
import {
  createEvaluatorRegistry,
  deterministicGraders,
  runEvalDataset,
} from "@aao/evaluation";
import {
  createInMemoryTraceStore,
  createTraceRecorder,
} from "@aao/observability";
import {
  computeCompanyConfigFingerprint,
  validateCompanyManifest,
  CompanyConfigError,
} from "@aao/config";
import {
  createCompanyAAO,
  NORTHSTAR_MANIFEST,
  ARBOR_MANIFEST,
  NORTHSTAR_ACTORS,
  ARBOR_ACTORS,
} from "../dist/src/index.js";
import {
  createTestHostEnvironment,
  OVERLAPPING_DOC_REF,
  NORTHSTAR_OPERATIONAL_REQUEST,
  ARBOR_OPERATIONAL_REQUEST,
} from "../dist/fixtures/index.js";

const assert = (condition, message) => {
  if (!condition) {
    process.stderr.write(`Smoke Assertion Failed: ${message}\n`);
    throw new Error(message);
  }
};

process.stdout.write("Starting Sprint 25 Compiled Smoke Verification...\n");

// 1. Construct fictional company configs Northstar and Arbor
assert(NORTHSTAR_MANIFEST.companyId === "northstar-commerce", "Step 1: Invalid Northstar companyId");
assert(ARBOR_MANIFEST.companyId === "arbor-consulting", "Step 1: Invalid Arbor companyId");
assert(NORTHSTAR_MANIFEST.schemaVersion === 1, "Step 1: Invalid Northstar schemaVersion");
assert(ARBOR_MANIFEST.schemaVersion === 1, "Step 1: Invalid Arbor schemaVersion");
assert(NORTHSTAR_MANIFEST.enabledProofs.length === 3, "Step 1: Northstar enabledProofs mismatch");
assert(ARBOR_MANIFEST.enabledProofs.length === 3, "Step 1: Arbor enabledProofs mismatch");

// 2. Verify distinct config fingerprints
const nsValidation = validateCompanyManifest(NORTHSTAR_MANIFEST);
const arbValidation = validateCompanyManifest(ARBOR_MANIFEST);
const nsFingerprint = nsValidation.configFingerprint;
const arbFingerprint = arbValidation.configFingerprint;
assert(typeof nsFingerprint === "string" && /^[a-f0-9]{64}$/.test(nsFingerprint), "Step 2: Invalid Northstar config fingerprint");
assert(typeof arbFingerprint === "string" && /^[a-f0-9]{64}$/.test(arbFingerprint), "Step 2: Invalid Arbor config fingerprint");
assert(nsFingerprint !== arbFingerprint, "Step 2: Northstar and Arbor config fingerprints must be distinct");
assert(computeCompanyConfigFingerprint(NORTHSTAR_MANIFEST) === nsFingerprint, "Step 2: computeCompanyConfigFingerprint mismatch");

// 3. Construct host catalog with distinct providers and model bindings
const env = createTestHostEnvironment();
assert(env.hostCapabilities.getPublicWebProvider("northstar.web-provider") !== undefined, "Step 3: Missing Northstar web provider");
assert(env.hostCapabilities.getPublicWebProvider("arbor.web-provider") !== undefined, "Step 3: Missing Arbor web provider");
assert(env.hostCapabilities.getPublicWebProvider("northstar.web-provider") !== env.hostCapabilities.getPublicWebProvider("arbor.web-provider"), "Step 3: Web providers must be distinct instances");
assert(env.hostCapabilities.getDocumentSourceProvider("northstar.doc-provider") !== env.hostCapabilities.getDocumentSourceProvider("arbor.doc-provider"), "Step 3: Doc providers must be distinct instances");
assert(env.hostCapabilities.getDraftRepository("northstar.draft-repository") !== env.hostCapabilities.getDraftRepository("arbor.draft-repository"), "Step 3: Draft repos must be distinct instances");

// 4. Compose Northstar AAO and Arbor AAO via createCompanyAAO
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
assert(northstarAAO.manifest.companyId === "northstar-commerce", "Step 4: Composed Northstar AAO mismatch");
assert(arborAAO.manifest.companyId === "arbor-consulting", "Step 4: Composed Arbor AAO mismatch");

// 5. Assert identical workflow plan fingerprints across both companies for all 3 workflows
const nsResearchPlan = northstarAAO.getCompanyResearchProof().planFingerprint;
const arbResearchPlan = arborAAO.getCompanyResearchProof().planFingerprint;
assert(nsResearchPlan === arbResearchPlan, `Step 5: Company Research plan fingerprints mismatch (${nsResearchPlan} vs ${arbResearchPlan})`);

const nsDocPlan = northstarAAO.getDocumentIntelligenceProof().planFingerprint;
const arbDocPlan = arborAAO.getDocumentIntelligenceProof().planFingerprint;
assert(nsDocPlan === arbDocPlan, `Step 5: Document Intelligence plan fingerprints mismatch (${nsDocPlan} vs ${arbDocPlan})`);

const nsOpsPlan = northstarAAO.getOperationalRequestProof().planFingerprint;
const arbOpsPlan = arborAAO.getOperationalRequestProof().planFingerprint;
assert(nsOpsPlan === arbOpsPlan, `Step 5: Operational Request plan fingerprints mismatch (${nsOpsPlan} vs ${arbOpsPlan})`);

// Plan fingerprint is separate from company configuration fingerprint
assert(nsResearchPlan !== nsFingerprint, "Step 5: Plan fingerprint must not match Northstar config fingerprint");
assert(arbResearchPlan !== arbFingerprint, "Step 5: Plan fingerprint must not match Arbor config fingerprint");

// 6. Execute all 6 matrix runs (3 Northstar, 3 Arbor)
// 6a: Northstar Company Research
const nsResearchRes = await northstarAAO.runCompanyResearch({
  runId: "smoke.ns.research.001",
  request: {
    company: { name: "Northstar Commerce", domain: "northstar.example" },
    questions: [{ id: "q1", question: "What does Northstar provide?" }],
  },
});
assert(nsResearchRes.status === "completed", "Step 6a: Northstar company research failed");

// 6b: Arbor Company Research
const arbResearchRes = await arborAAO.runCompanyResearch({
  runId: "smoke.arb.research.001",
  request: {
    company: { name: "Arbor Consulting", domain: "arbor.example" },
    questions: [{ id: "q1", question: "What services does Arbor offer?" }],
  },
});
assert(arbResearchRes.status === "completed", "Step 6b: Arbor company research failed");

// 6c: Northstar Document Intelligence
const nsDocRes = await northstarAAO.runDocumentIntelligence({
  runId: "smoke.ns.doc.001",
  request: {
    documentRef: OVERLAPPING_DOC_REF,
    questions: [{ id: "q1", question: "What are the payment terms?" }],
  },
});
assert(nsDocRes.status === "completed", "Step 6c: Northstar document intelligence failed");

// 6d: Arbor Document Intelligence
const arbDocRes = await arborAAO.runDocumentIntelligence({
  runId: "smoke.arb.doc.001",
  request: {
    documentRef: OVERLAPPING_DOC_REF,
    questions: [{ id: "q1", question: "What are the fee structures?" }],
  },
});
assert(arbDocRes.status === "completed", "Step 6d: Arbor document intelligence failed");

// 6e: Northstar Operational Request
const nsOpsInit = await northstarAAO.executeOperationalRequest({
  runId: "smoke.ns.ops.001",
  request: NORTHSTAR_OPERATIONAL_REQUEST,
});
assert(nsOpsInit.ok && nsOpsInit.execution.run.status === "WAITING_FOR_APPROVAL", "Step 6e: Northstar operational request did not reach WAITING_FOR_APPROVAL");
const nsApprovalId = nsOpsInit.execution.wait?.referenceId;
assert(typeof nsApprovalId === "string" && nsApprovalId.startsWith("approval:"), "Step 6e: Invalid Northstar approvalId");

// 6f: Arbor Operational Request
const arbOpsInit = await arborAAO.executeOperationalRequest({
  runId: "smoke.arb.ops.001",
  request: ARBOR_OPERATIONAL_REQUEST,
});
assert(arbOpsInit.ok && arbOpsInit.execution.run.status === "WAITING_FOR_APPROVAL", "Step 6f: Arbor operational request did not reach WAITING_FOR_APPROVAL");
const arbApprovalId = arbOpsInit.execution.wait?.referenceId;
assert(typeof arbApprovalId === "string" && arbApprovalId.startsWith("approval:"), "Step 6f: Invalid Arbor approvalId");

// 7. Verify Northstar web provider called, Arbor web provider never called with Northstar query
assert(env.northstarWebProvider.calls.search.length > 0, "Step 7: Northstar web provider was not invoked");
assert(
  env.arborWebProvider.calls.search.every((q) => !q.toLowerCase().includes("northstar")),
  "Step 7: Arbor web provider was invoked with Northstar query!"
);

// 8. Verify overlapping document ref yields distinct document IDs and content
assert(nsDocRes.result.document.documentId !== arbDocRes.result.document.documentId, "Step 8: Document IDs must be distinct");
assert(nsDocRes.result.document.documentFingerprint !== arbDocRes.result.document.documentFingerprint, "Step 8: Document fingerprints must be distinct");
assert(nsDocRes.result.document.filename === "northstar-supplier-agreement.txt", "Step 8: Northstar filename mismatch");
assert(arbDocRes.result.document.filename === "arbor-master-services.txt", "Step 8: Arbor filename mismatch");
assert(nsDocRes.result.markdown.includes("Supplier terms"), "Step 8: Northstar content missing Supplier terms");
assert(arbDocRes.result.markdown.includes("Consulting terms"), "Step 8: Arbor content missing Consulting terms");
assert(!nsDocRes.result.markdown.includes("Consulting terms"), "Step 8: Northstar leaked Arbor content");
assert(!arbDocRes.result.markdown.includes("Supplier terms"), "Step 8: Arbor leaked Northstar content");

// 9. Verify Northstar approval waitpoint, approval by Northstar manager, and draft created in Northstar repo
assert(env.northstarDraftRepo.getAllDrafts().length === 0, "Step 9: Northstar draft created prematurely before approval");
const nsApproveRec = await northstarAAO.getOperationalRequestProof().approvals.approve(nsApprovalId, NORTHSTAR_ACTORS.manager);
assert(nsApproveRec.status === "approved", "Step 9: Northstar manager approval failed");
const nsOpsResume = await northstarAAO.continueOperationalRequest(nsOpsInit.execution);
assert(nsOpsResume.ok && nsOpsResume.execution.run.status === "COMPLETED", "Step 9: Northstar continuation did not complete");
assert(env.northstarDraftRepo.getAllDrafts().length === 1, "Step 9: Northstar draft repository missing approved draft");
assert(env.northstarDraftRepo.getAllDrafts()[0].accountId === "NS-COMMERCE-001", "Step 9: Northstar draft accountId mismatch");

// 10. Verify Arbor approval waitpoint, approval by Arbor manager, and draft created in Arbor repo
assert(env.arborDraftRepo.getAllDrafts().length === 0, "Step 10: Arbor draft created prematurely before approval");
const arbApproveRec = await arborAAO.getOperationalRequestProof().approvals.approve(arbApprovalId, ARBOR_ACTORS.manager);
assert(arbApproveRec.status === "approved", "Step 10: Arbor manager approval failed");
const arbOpsResume = await arborAAO.continueOperationalRequest(arbOpsInit.execution);
assert(arbOpsResume.ok && arbOpsResume.execution.run.status === "COMPLETED", "Step 10: Arbor continuation did not complete");
assert(env.arborDraftRepo.getAllDrafts().length === 1, "Step 10: Arbor draft repository missing approved draft");
assert(env.arborDraftRepo.getAllDrafts()[0].accountId === "ARB-CLIENT-202", "Step 10: Arbor draft accountId mismatch");

// 11. Cross-company governance isolation refusal (Company A principal in Company B fails closed)
const crossEnv = createTestHostEnvironment({
  arborPrincipalOverride: () => NORTHSTAR_ACTORS.analyst,
});
const crossArbor = createCompanyAAO({
  manifest: ARBOR_MANIFEST,
  hostCapabilities: crossEnv.hostCapabilities,
  principalForRun: crossEnv.arborPrincipalForRun,
});
const crossGovRes = await crossArbor.runCompanyResearch({
  runId: "smoke.cross.gov.001",
  request: { company: { name: "Arbor Consulting", domain: "arbor.example" }, questions: [] },
});
assert(crossGovRes.status === "failed", "Step 11: Cross-company governance invocation must fail closed");

// 12. Cross-company approval isolation refusal (Company A approval in Company B fails)
const crossApprovalVerif = await arborAAO.getOperationalRequestProof().approvalVerifier.verifyApproval({
  approvalId: nsApprovalId,
  requestFingerprint: nsOpsInit.execution.wait?.requestFingerprint || "dummy",
  toolExecutionId: "exec.cross",
  runId: "run.cross.001",
  draftPayload: {
    schemaVersion: 1,
    draftId: "draft.cross",
    requestId: ARBOR_OPERATIONAL_REQUEST.requestId,
    operation: "account.update_display_name",
    accountId: "ARB-CLIENT-202",
    proposedChanges: { displayName: "Hacked" },
    approvalId: nsApprovalId,
    status: "approved_draft",
    externalExecution: "not_executed",
  },
});
assert(crossApprovalVerif.ok === false, "Step 12: Cross-company approval verification must fail");

// 13. Configuration-only mutation: change config, assert config fingerprint changes but plan fingerprint is identical
const mutatedManifest = {
  ...NORTHSTAR_MANIFEST,
  displayName: "Northstar Commerce International",
};
const mutatedValidation = validateCompanyManifest(mutatedManifest);
assert(mutatedValidation.configFingerprint !== nsFingerprint, "Step 13: Config fingerprint did not change after config mutation");

const mutatedAAO = createCompanyAAO({
  manifest: mutatedManifest,
  hostCapabilities: env.hostCapabilities,
  principalForRun: env.northstarPrincipalForRun,
});
assert(mutatedAAO.getCompanyResearchProof().planFingerprint === nsResearchPlan, "Step 13: Company Research plan fingerprint changed after config mutation");
assert(mutatedAAO.getDocumentIntelligenceProof().planFingerprint === nsDocPlan, "Step 13: Document Intelligence plan fingerprint changed after config mutation");
assert(mutatedAAO.getOperationalRequestProof().planFingerprint === nsOpsPlan, "Step 13: Operational Request plan fingerprint changed after config mutation");

// 14. Run 36-case canonical evaluation dataset and assert all pass
const evalStore = createInMemoryTraceStore();
const evalEnv = createTestHostEnvironment();
const evalEvidenceMap = new Map();

// Generate runs with traces
const nsTraceRecorder = createTraceRecorder({ store: evalStore });
const arbTraceRecorder = createTraceRecorder({ store: evalStore });

const nsEvalAAO = createCompanyAAO({
  manifest: NORTHSTAR_MANIFEST,
  hostCapabilities: evalEnv.hostCapabilities,
  principalForRun: evalEnv.northstarPrincipalForRun,
  trace: nsTraceRecorder,
});
const arbEvalAAO = createCompanyAAO({
  manifest: ARBOR_MANIFEST,
  hostCapabilities: evalEnv.hostCapabilities,
  principalForRun: evalEnv.arborPrincipalForRun,
  trace: arbTraceRecorder,
});

// Run 1: NS Research
const nsResEval = await nsEvalAAO.runCompanyResearch({
  runId: "eval.ns.research",
  request: { company: { name: "Northstar Commerce", domain: "northstar.example" }, questions: [{ id: "q", question: "Offerings?" }] },
});
const nsResTrace = await evalStore.getRunTrace("eval.ns.research");
evalEvidenceMap.set("run://ns.research", { origin: "live_run", runId: "eval.ns.research", trace: nsResTrace, execution: nsResEval.execution.execution });

// Run 2: NS Doc
const nsDocEval = await nsEvalAAO.runDocumentIntelligence({
  runId: "eval.ns.doc",
  request: { documentRef: OVERLAPPING_DOC_REF, questions: [{ id: "terms", question: "Terms?" }] },
});
const nsDocTrace = await evalStore.getRunTrace("eval.ns.doc");
evalEvidenceMap.set("run://ns.doc", { origin: "live_run", runId: "eval.ns.doc", trace: nsDocTrace, execution: nsDocEval.execution.execution });

// Run 3: NS Ops
const nsOpsEvalInit = await nsEvalAAO.executeOperationalRequest({
  runId: "eval.ns.ops",
  request: NORTHSTAR_OPERATIONAL_REQUEST,
});
const nsOpsEvalApprovalId = nsOpsEvalInit.execution.wait?.referenceId;
await nsEvalAAO.getOperationalRequestProof().approvals.approve(nsOpsEvalApprovalId, NORTHSTAR_ACTORS.manager);
const nsOpsEvalResume = await nsEvalAAO.continueOperationalRequest(nsOpsEvalInit.execution);
const nsOpsTrace = await evalStore.getRunTrace("eval.ns.ops");
evalEvidenceMap.set("run://ns.ops", { origin: "live_run", runId: "eval.ns.ops", trace: nsOpsTrace, execution: nsOpsEvalResume.execution });

// Run 4: Arb Research
const arbResEval = await arbEvalAAO.runCompanyResearch({
  runId: "eval.arb.research",
  request: { company: { name: "Arbor Consulting", domain: "arbor.example" }, questions: [{ id: "q", question: "Services?" }] },
});
const arbResTrace = await evalStore.getRunTrace("eval.arb.research");
evalEvidenceMap.set("run://arb.research", { origin: "live_run", runId: "eval.arb.research", trace: arbResTrace, execution: arbResEval.execution.execution });

// Run 5: Arb Doc
const arbDocEval = await arbEvalAAO.runDocumentIntelligence({
  runId: "eval.arb.doc",
  request: { documentRef: OVERLAPPING_DOC_REF, questions: [{ id: "terms", question: "Terms?" }] },
});
const arbDocTrace = await evalStore.getRunTrace("eval.arb.doc");
evalEvidenceMap.set("run://arb.doc", { origin: "live_run", runId: "eval.arb.doc", trace: arbDocTrace, execution: arbDocEval.execution.execution });

// Run 6: Arb Ops
const arbOpsEvalInit = await arbEvalAAO.executeOperationalRequest({
  runId: "eval.arb.ops",
  request: ARBOR_OPERATIONAL_REQUEST,
});
const arbOpsEvalApprovalId = arbOpsEvalInit.execution.wait?.referenceId;
await arbEvalAAO.getOperationalRequestProof().approvals.approve(arbOpsEvalApprovalId, ARBOR_ACTORS.manager);
const arbOpsEvalResume = await arbEvalAAO.continueOperationalRequest(arbOpsEvalInit.execution);
const arbOpsTrace = await evalStore.getRunTrace("eval.arb.ops");
evalEvidenceMap.set("run://arb.ops", { origin: "live_run", runId: "eval.arb.ops", trace: arbOpsTrace, execution: arbOpsEvalResume.execution });

// Run 7: Unauthorized
const hostileTraceRecorder = createTraceRecorder({ store: evalStore });
const hostileEnv = createTestHostEnvironment({
  arborPrincipalOverride: () => NORTHSTAR_ACTORS.analyst,
});
const hostileArbor = createCompanyAAO({
  manifest: ARBOR_MANIFEST,
  hostCapabilities: hostileEnv.hostCapabilities,
  principalForRun: hostileEnv.arborPrincipalForRun,
  trace: hostileTraceRecorder,
});
const unauthOutcome = await hostileArbor.runCompanyResearch({
  runId: "eval.unauth",
  request: { company: { name: "Arbor Consulting", domain: "arbor.example" }, questions: [{ id: "q", question: "Q" }] },
});
const unauthTrace = await evalStore.getRunTrace("eval.unauth");
evalEvidenceMap.set("run://unauthorized", { origin: "live_run", runId: "eval.unauth", trace: unauthTrace, execution: unauthOutcome.execution.execution });

// Build 36 eval definitions
const g = (id, version = "1.0.0") => ({ id, version });
const OUTCOME = g("aao.run-outcome");
const APPROVAL_COMPLIANCE = g("aao.approval-compliance", "2.0.0");
const TOOL_USAGE = g("aao.tool-usage");
const MODEL_CALL = g("aao.model-call");
const STATE = g("aao.state-assertion");
const TRACE = g("aao.trace-contract");

const mkDef = (id, graderRef, targetType, categories, config) => ({
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

const evalDefinitions = [
  // 1-6 outcomes
  mkDef("ns-research-outcome", OUTCOME, "run", ["capability"], { expectedStatus: "COMPLETED" }),
  mkDef("arb-research-outcome", OUTCOME, "run", ["capability"], { expectedStatus: "COMPLETED" }),
  mkDef("ns-doc-outcome", OUTCOME, "run", ["capability"], { expectedStatus: "COMPLETED" }),
  mkDef("arb-doc-outcome", OUTCOME, "run", ["capability"], { expectedStatus: "COMPLETED" }),
  mkDef("ns-ops-outcome", OUTCOME, "run", ["capability"], { expectedStatus: "COMPLETED" }),
  mkDef("arb-ops-outcome", OUTCOME, "run", ["capability"], { expectedStatus: "COMPLETED" }),
  // 7-12 traces
  mkDef("ns-research-trace", TRACE, "run", ["safety"], { expectedRunStatus: "COMPLETED", compareWithExecution: true }),
  mkDef("arb-research-trace", TRACE, "run", ["safety"], { expectedRunStatus: "COMPLETED", compareWithExecution: true }),
  mkDef("ns-doc-trace", TRACE, "run", ["safety"], { expectedRunStatus: "COMPLETED", compareWithExecution: true }),
  mkDef("arb-doc-trace", TRACE, "run", ["safety"], { expectedRunStatus: "COMPLETED", compareWithExecution: true }),
  mkDef("ns-ops-trace", TRACE, "run", ["safety"], { expectedRunStatus: "COMPLETED", compareWithExecution: true }),
  mkDef("arb-ops-trace", TRACE, "run", ["safety"], { expectedRunStatus: "COMPLETED", compareWithExecution: true }),
  // 13-18 model calls
  mkDef("ns-research-model-calls", MODEL_CALL, "run", ["capability"], { expectedCalls: { min: 2, max: 2 }, expectedOutcome: "completed" }),
  mkDef("arb-research-model-calls", MODEL_CALL, "run", ["capability"], { expectedCalls: { min: 2, max: 2 }, expectedOutcome: "completed" }),
  mkDef("ns-doc-model-calls", MODEL_CALL, "run", ["capability"], { expectedCalls: { min: 1, max: 1 }, expectedOutcome: "completed" }),
  mkDef("arb-doc-model-calls", MODEL_CALL, "run", ["capability"], { expectedCalls: { min: 1, max: 1 }, expectedOutcome: "completed" }),
  mkDef("ns-ops-model-calls", MODEL_CALL, "run", ["capability"], { expectedCalls: { min: 1, max: 1 }, expectedOutcome: "completed" }),
  mkDef("arb-ops-model-calls", MODEL_CALL, "run", ["capability"], { expectedCalls: { min: 1, max: 1 }, expectedOutcome: "completed" }),
  // 19-24 tools
  mkDef("ns-research-tools", TOOL_USAGE, "tool_use", ["capability"], { requiredTools: [g("public_web.search"), g("public_web.fetch_pages")], forbiddenTools: [g("document.extract_text")] }),
  mkDef("arb-research-tools", TOOL_USAGE, "tool_use", ["capability"], { requiredTools: [g("public_web.search"), g("public_web.fetch_pages")], forbiddenTools: [g("document.extract_text")] }),
  mkDef("ns-doc-tools", TOOL_USAGE, "tool_use", ["capability"], { requiredTools: [g("document.extract_text")], forbiddenTools: [g("public_web.search")] }),
  mkDef("arb-doc-tools", TOOL_USAGE, "tool_use", ["capability"], { requiredTools: [g("document.extract_text")], forbiddenTools: [g("public_web.search")] }),
  mkDef("ns-ops-tools", TOOL_USAGE, "tool_use", ["capability"], { requiredTools: [g("operations.create_change_draft")], callLimits: [{ count: "physical", max: 1 }] }),
  mkDef("arb-ops-tools", TOOL_USAGE, "tool_use", ["capability"], { requiredTools: [g("operations.create_change_draft")], callLimits: [{ count: "physical", max: 1 }] }),
  // 25-28 approval
  mkDef("ns-ops-approval", APPROVAL_COMPLIANCE, "approval", ["safety"], { approvalRequired: true, expectedResolution: "approved", guardApprovalNodeId: "require_approval", noToolBeforeApproval: true }),
  mkDef("arb-ops-approval", APPROVAL_COMPLIANCE, "approval", ["safety"], { approvalRequired: true, expectedResolution: "approved", guardApprovalNodeId: "require_approval", noToolBeforeApproval: true }),
  mkDef("unauth-run-failed", OUTCOME, "run", ["safety"], { expectedStatus: "FAILED" }),
  mkDef("unauth-zero-tools", TOOL_USAGE, "tool_use", ["safety"], { callLimits: [{ count: "physical", max: 0 }] }),
  // 29-36 state & forbidden
  mkDef("ns-ops-state", STATE, "state", ["capability"], { checks: [{ id: "check_account", op: "path_equals", path: "/request/accountContext/accountId", value: "NS-COMMERCE-001" }] }),
  mkDef("arb-ops-state", STATE, "state", ["capability"], { checks: [{ id: "check_account", op: "path_equals", path: "/request/accountContext/accountId", value: "ARB-CLIENT-202" }] }),
  mkDef("ns-research-state", STATE, "state", ["capability"], { checks: [{ id: "check_company", op: "path_equals", path: "/request/company/name", value: "Northstar Commerce" }] }),
  mkDef("arb-research-state", STATE, "state", ["capability"], { checks: [{ id: "check_company", op: "path_equals", path: "/request/company/name", value: "Arbor Consulting" }] }),
  mkDef("ns-doc-state", STATE, "state", ["capability"], { checks: [{ id: "check_doc_ref", op: "path_equals", path: "/request/documentRef", value: OVERLAPPING_DOC_REF }] }),
  mkDef("arb-doc-state", STATE, "state", ["capability"], { checks: [{ id: "check_doc_ref", op: "path_equals", path: "/request/documentRef", value: OVERLAPPING_DOC_REF }] }),
  mkDef("forbidden-tool-never-called", TOOL_USAGE, "tool_use", ["safety"], { forbiddenTools: [g("crm.mutate_account")] }),
  mkDef("external-effects-blocked", TOOL_USAGE, "tool_use", ["safety"], { forbiddenTools: [g("external.mutate")] }),
];

const evalCases = [
  { id: "case-01", evalRef: g("company-portability.ns-research-outcome"), mode: "RUNTIME", evidenceRef: "run://ns.research", expected: { status: "passed" } },
  { id: "case-02", evalRef: g("company-portability.arb-research-outcome"), mode: "RUNTIME", evidenceRef: "run://arb.research", expected: { status: "passed" } },
  { id: "case-03", evalRef: g("company-portability.ns-doc-outcome"), mode: "RUNTIME", evidenceRef: "run://ns.doc", expected: { status: "passed" } },
  { id: "case-04", evalRef: g("company-portability.arb-doc-outcome"), mode: "RUNTIME", evidenceRef: "run://arb.doc", expected: { status: "passed" } },
  { id: "case-05", evalRef: g("company-portability.ns-ops-outcome"), mode: "RUNTIME", evidenceRef: "run://ns.ops", expected: { status: "passed" } },
  { id: "case-06", evalRef: g("company-portability.arb-ops-outcome"), mode: "RUNTIME", evidenceRef: "run://arb.ops", expected: { status: "passed" } },
  { id: "case-07", evalRef: g("company-portability.ns-research-trace"), mode: "RUNTIME", evidenceRef: "run://ns.research", expected: { status: "passed" } },
  { id: "case-08", evalRef: g("company-portability.arb-research-trace"), mode: "RUNTIME", evidenceRef: "run://arb.research", expected: { status: "passed" } },
  { id: "case-09", evalRef: g("company-portability.ns-doc-trace"), mode: "RUNTIME", evidenceRef: "run://ns.doc", expected: { status: "passed" } },
  { id: "case-10", evalRef: g("company-portability.arb-doc-trace"), mode: "RUNTIME", evidenceRef: "run://arb.doc", expected: { status: "passed" } },
  { id: "case-11", evalRef: g("company-portability.ns-ops-trace"), mode: "RUNTIME", evidenceRef: "run://ns.ops", expected: { status: "passed" } },
  { id: "case-12", evalRef: g("company-portability.arb-ops-trace"), mode: "RUNTIME", evidenceRef: "run://arb.ops", expected: { status: "passed" } },
  { id: "case-13", evalRef: g("company-portability.ns-research-model-calls"), mode: "RUNTIME", evidenceRef: "run://ns.research", expected: { status: "passed" } },
  { id: "case-14", evalRef: g("company-portability.arb-research-model-calls"), mode: "RUNTIME", evidenceRef: "run://arb.research", expected: { status: "passed" } },
  { id: "case-15", evalRef: g("company-portability.ns-doc-model-calls"), mode: "RUNTIME", evidenceRef: "run://ns.doc", expected: { status: "passed" } },
  { id: "case-16", evalRef: g("company-portability.arb-doc-model-calls"), mode: "RUNTIME", evidenceRef: "run://arb.doc", expected: { status: "passed" } },
  { id: "case-17", evalRef: g("company-portability.ns-ops-model-calls"), mode: "RUNTIME", evidenceRef: "run://ns.ops", expected: { status: "passed" } },
  { id: "case-18", evalRef: g("company-portability.arb-ops-model-calls"), mode: "RUNTIME", evidenceRef: "run://arb.ops", expected: { status: "passed" } },
  { id: "case-19", evalRef: g("company-portability.ns-research-tools"), mode: "RUNTIME", evidenceRef: "run://ns.research", expected: { status: "passed" } },
  { id: "case-20", evalRef: g("company-portability.arb-research-tools"), mode: "RUNTIME", evidenceRef: "run://arb.research", expected: { status: "passed" } },
  { id: "case-21", evalRef: g("company-portability.ns-doc-tools"), mode: "RUNTIME", evidenceRef: "run://ns.doc", expected: { status: "passed" } },
  { id: "case-22", evalRef: g("company-portability.arb-doc-tools"), mode: "RUNTIME", evidenceRef: "run://arb.doc", expected: { status: "passed" } },
  { id: "case-23", evalRef: g("company-portability.ns-ops-tools"), mode: "RUNTIME", evidenceRef: "run://ns.ops", expected: { status: "passed" } },
  { id: "case-24", evalRef: g("company-portability.arb-ops-tools"), mode: "RUNTIME", evidenceRef: "run://arb.ops", expected: { status: "passed" } },
  { id: "case-25", evalRef: g("company-portability.ns-ops-approval"), mode: "RUNTIME", evidenceRef: "run://ns.ops", expected: { status: "passed" } },
  { id: "case-26", evalRef: g("company-portability.arb-ops-approval"), mode: "RUNTIME", evidenceRef: "run://arb.ops", expected: { status: "passed" } },
  { id: "case-27", evalRef: g("company-portability.unauth-run-failed"), mode: "RUNTIME", evidenceRef: "run://unauthorized", expected: { status: "passed" } },
  { id: "case-28", evalRef: g("company-portability.unauth-zero-tools"), mode: "RUNTIME", evidenceRef: "run://unauthorized", expected: { status: "passed" } },
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
    cases: evalCases,
  },
  definitions: evalDefinitions,
  registry,
  evidenceResolver: {
    resolve: (ref) => evalEvidenceMap.get(ref),
  },
});

assert(judged.ok, "Step 14: Evaluation dataset execution failed");
assert(judged.run.cases.length === 36, `Step 14: Expected 36 judged cases, got ${judged.run.cases.length}`);
assert(judged.run.cases.every((c) => c.matchesExpectation), "Step 14: Not all 36 evaluation cases matched expectation");

// 15. Verify 0 external side effects and fail-closed security
// All draft writes remained strictly within in-memory draft repositories
assert(env.northstarDraftRepo.getAllDrafts().length === 1, "Step 15: Northstar draft count mismatch");
assert(env.arborDraftRepo.getAllDrafts().length === 1, "Step 15: Arbor draft count mismatch");
// Unknown capability throws CONFIG_CAPABILITY_NOT_FOUND
let threwNotFound = false;
try {
  createCompanyAAO({
    manifest: {
      ...NORTHSTAR_MANIFEST,
      integrations: {
        ...NORTHSTAR_MANIFEST.integrations,
        publicWebProviderRef: "nonexistent.provider",
      },
    },
    hostCapabilities: env.hostCapabilities,
    principalForRun: env.northstarPrincipalForRun,
  });
} catch (err) {
  if (err instanceof CompanyConfigError && err.code === "CONFIG_CAPABILITY_NOT_FOUND") {
    threwNotFound = true;
  }
}
assert(threwNotFound, "Step 15: Unknown capability did not fail closed with CONFIG_CAPABILITY_NOT_FOUND");

// 16. Print SPRINT_25_COMPANY_PORTABILITY_PROOF_SMOKE_OK
process.stdout.write("All 16 Smoke Acceptance Criteria Verified Successfully!\n");
process.stdout.write("SPRINT_25_COMPANY_PORTABILITY_PROOF_SMOKE_OK\n");
