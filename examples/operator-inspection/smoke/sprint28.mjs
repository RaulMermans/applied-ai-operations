// Sprint 28 compiled smoke: Guided Integration Diagnostics & Advanced Run Inspector.
// Offline, read-only, deterministic execution over compiled package outputs only.
import process from "node:process";
import {
  CANONICAL_NORTHSTAR_MANIFEST,
  COMPANY_RESEARCH_PACK,
  createCanonicalDemoInspectionSource,
  createOperatorInspectionService,
  createVerifiedRegistrationEvidenceForCompany,
  formatAdvancedRunInspectionNodesText,
  formatAdvancedRunInspectionTimelineText,
  formatIntegrationDiagnosticsText,
  getRemediationForCode,
  projectIntegrationDiagnostics,
} from "@aao/operator-inspection";
import { buildApp } from "../../../apps/control-plane/dist/app.js";

const assert = (condition, message) => {
  if (!condition) {
    process.stderr.write(`Smoke Assertion Failed: ${message}\n`);
    throw new Error(message);
  }
};

process.stdout.write("Running Sprint 28 Compiled Smoke...\n");

// 1. Diagnostics: Verified Pack -> READY
const nsEvidence = createVerifiedRegistrationEvidenceForCompany("northstar-commerce");
const readyReport = projectIntegrationDiagnostics({
  companyManifest: CANONICAL_NORTHSTAR_MANIFEST,
  pack: COMPANY_RESEARCH_PACK,
  registrationEvidence: nsEvidence.company_research,
});
assert(readyReport.status === "READY", "Verified pack must produce READY status");
assert(readyReport.requirements.length > 0, "Requirements checklist must be populated");
assert(readyReport.requirements.every((r) => r.status === "SATISFIED"), "All requirements must be SATISFIED");
assert(readyReport.nextSteps.length > 0, "Next steps must be provided");
const formattedReport = formatIntegrationDiagnosticsText(readyReport);
assert(formattedReport.includes("READY"), "Formatted diagnostic report must include status");

// 2. Diagnostics: Missing Tool -> BLOCKED
const missingToolReport = projectIntegrationDiagnostics({
  companyManifest: CANONICAL_NORTHSTAR_MANIFEST,
  pack: COMPANY_RESEARCH_PACK,
  registrationEvidence: {
    ...nsEvidence.company_research,
    registeredTools: [],
  },
});
assert(missingToolReport.status === "BLOCKED", "Missing tool must produce BLOCKED status");
assert(missingToolReport.reasonCode === "PACK_REQUIREMENT_MISSING", "Reason code must be PACK_REQUIREMENT_MISSING");
const toolReq = missingToolReport.requirements.find((r) => r.category === "tool");
assert(toolReq && toolReq.status === "MISSING", "Tool requirement must be marked MISSING");
assert(toolReq.remediation && toolReq.remediation.includes("Tool"), "Actionable remediation must reference Tool");

// 3. Diagnostics: Adapter Capability Mismatch -> BLOCKED
const incompatibleAdapterReport = projectIntegrationDiagnostics({
  companyManifest: CANONICAL_NORTHSTAR_MANIFEST,
  pack: COMPANY_RESEARCH_PACK,
  registrationEvidence: {
    ...nsEvidence.company_research,
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
assert(incompatibleAdapterReport.status === "BLOCKED", "Incompatible adapter must produce BLOCKED");
assert(incompatibleAdapterReport.reasonCode === "PACK_CAPABILITY_INCOMPATIBLE", "Reason code must be PACK_CAPABILITY_INCOMPATIBLE");

// 4. Diagnostics: Missing Eval Profile -> BLOCKED
const missingEvalReport = projectIntegrationDiagnostics({
  companyManifest: CANONICAL_NORTHSTAR_MANIFEST,
  pack: COMPANY_RESEARCH_PACK,
  registrationEvidence: {
    ...nsEvidence.company_research,
    registeredEvalProfiles: [],
  },
});
assert(missingEvalReport.status === "BLOCKED", "Missing eval profile must produce BLOCKED");
assert(missingEvalReport.reasonCode === "PACK_VERIFICATION_PROFILE_MISSING", "Reason code must be PACK_VERIFICATION_PROFILE_MISSING");

// 5. Diagnostics: Missing Registration Snapshot -> NOT_VERIFIED
const unverifiedReport = projectIntegrationDiagnostics({
  companyManifest: CANONICAL_NORTHSTAR_MANIFEST,
  pack: COMPANY_RESEARCH_PACK,
  registrationEvidence: undefined,
});
assert(unverifiedReport.status === "NOT_VERIFIED", "Missing registration snapshot must produce NOT_VERIFIED");
assert(unverifiedReport.reasonCode === "PACK_EVIDENCE_UNAVAILABLE", "Reason code must be PACK_EVIDENCE_UNAVAILABLE");

// 6. Diagnostics: Disabled Proof -> BLOCKED
const disabledReport = projectIntegrationDiagnostics({
  companyManifest: {
    ...CANONICAL_NORTHSTAR_MANIFEST,
    enabledProofs: ["operational_request"],
  },
  pack: COMPANY_RESEARCH_PACK,
  registrationEvidence: nsEvidence.company_research,
});
assert(disabledReport.status === "BLOCKED", "Disabled proof must produce BLOCKED");
assert(disabledReport.reasonCode === "PACK_PROOF_DISABLED", "Reason code must be PACK_PROOF_DISABLED");

// 7. Remediation guidance mapping
assert(getRemediationForCode("PACK_REQUIREMENT_MISSING").includes("Tool, Policy or integration"), "Remediation mapping for missing requirement");
assert(getRemediationForCode("PACK_CAPABILITY_INCOMPATIBLE").includes("adapter capability"), "Remediation mapping for capability mismatch");

// 8. Advanced Run Inspector over canonical source
const source = await createCanonicalDemoInspectionSource({ includeExtendedRuns: true });
const service = createOperatorInspectionService(source);

// 8a. Single-attempt run (run.northstar.cr.001)
const singleRun = await service.getAdvancedRunInspection("run.northstar.cr.001");
assert(singleRun.runId === "run.northstar.cr.001", "runId matches");
assert(singleRun.authoritativeStatus === "COMPLETED", "Authoritative status COMPLETED");
assert(singleRun.statusSource === "authoritative_runtime", "Source authoritative_runtime");
assert(singleRun.nodes.length > 0, "Nodes mapped");
assert(singleRun.attempts.length > 0, "Attempts mapped");
assert(singleRun.attempts.every((a) => a.attempt === 1), "Single attempt per step");

const singleNodesText = formatAdvancedRunInspectionNodesText(singleRun);
assert(singleNodesText.includes("Run Node Execution: run.northstar.cr.001"), "CLI format nodes text includes header");
assert(singleNodesText.includes("OBSERVED_COMPLETED"), "CLI format includes node status");

// 8b. Multi-attempt tool retry run (run.northstar.cr.retry)
const retryRun = await service.getAdvancedRunInspection("run.northstar.cr.retry");
assert(retryRun.runId === "run.northstar.cr.retry", "Retry run matches");
const searchNode = retryRun.nodes.find((n) => n.nodeId === "search");
assert(searchNode && searchNode.totalAttempts === 2, "Search node has 2 attempts");
assert(searchNode.attempts[0].status === "failed", "Attempt 1 failed");
assert(searchNode.attempts[1].status === "completed", "Attempt 2 completed");
assert(searchNode.diagnostics.some((d) => d.includes("retries observed")), "Retries flagged in diagnostics");

const retryTimelineText = formatAdvancedRunInspectionTimelineText(retryRun);
assert(retryTimelineText.includes("attempt=1") && retryTimelineText.includes("attempt=2"), "Timeline shows both attempts");

// 8c. Recovery replay run (run.northstar.ops.recovery)
const recoveryRun = await service.getAdvancedRunInspection("run.northstar.ops.recovery");
assert(recoveryRun.runId === "run.northstar.ops.recovery", "Recovery run matches");
const recoveryAttempt = recoveryRun.attempts.find((a) => a.recoveryReplay === true);
assert(recoveryAttempt !== undefined, "Recovery attempt flagged with recoveryReplay=true");

// 8d. Token usage: unrecorded reported as NOT RECORDED (never substituted with zero)
const unrecordedRun = await service.getAdvancedRunInspection("run.arbor.di.001");
assert(unrecordedRun.tokenUsage?.recorded === false, "tokenUsage.recorded must be false");
assert(unrecordedRun.tokenUsage?.totalTokens === undefined, "totalTokens must be undefined, not 0");
const unrecordedText = formatAdvancedRunInspectionNodesText(unrecordedRun);
assert(unrecordedText.includes("Token Usage: NOT RECORDED"), "CLI text reports NOT RECORDED");

// 8e. Incomplete run reported as UNKNOWN
const incompleteRun = await service.getAdvancedRunInspection("run.arbor.cr.incomplete");
assert(incompleteRun.authoritativeStatus === "UNKNOWN", "Incomplete run reported as UNKNOWN");
assert(incompleteRun.statusSource === "unavailable", "Status source unavailable");

// 9. Fastify Control Plane API & UI routes
const app = buildApp({ inspectionSource: source });
const loopbackHeaders = { host: "127.0.0.1:4000" };

// 9a. Integration Diagnostics HTTP API
const apiDiagRes = await app.inject({
  method: "GET",
  url: "/api/v1/inspection/companies/northstar-commerce/packs/aao.company-research@1.0.0/diagnostics",
  headers: loopbackHeaders,
});
assert(apiDiagRes.statusCode === 200, "API diagnostics route returns 200");
const apiDiagJson = apiDiagRes.json();
assert(apiDiagJson.companyId === "northstar-commerce", "Company ID in API response");
assert(apiDiagJson.requirements.length > 0, "Requirements in API response");

// 9b. Advanced Run Analysis HTTP API
const apiAnalysisRes = await app.inject({
  method: "GET",
  url: "/api/v1/inspection/runs/run.northstar.cr.retry/analysis",
  headers: loopbackHeaders,
});
assert(apiAnalysisRes.statusCode === 200, "API analysis route returns 200");
const apiAnalysisJson = apiAnalysisRes.json();
assert(apiAnalysisJson.runId === "run.northstar.cr.retry", "Run ID in analysis response");
assert(apiAnalysisJson.nodes.length > 0, "Nodes in analysis response");

// 9c. Control Center UI: Integration Diagnostics page
const uiDiagRes = await app.inject({
  method: "GET",
  url: "/control-center/companies/northstar-commerce/packs/aao.company-research@1.0.0",
  headers: loopbackHeaders,
});
assert(uiDiagRes.statusCode === 200, "UI diagnostics route returns 200");
assert(uiDiagRes.headers["content-type"].includes("text/html"), "Content type HTML");
assert(uiDiagRes.body.includes("Integration Readiness Overview"), "Readiness overview in HTML");
assert(uiDiagRes.body.includes("Requirements Checklist"), "Checklist in HTML");
assert(uiDiagRes.body.includes("Actionable Next Steps"), "Next steps in HTML");
assert(uiDiagRes.body.includes("READ-ONLY SURFACE"), "Read-only banner in HTML");
assert(!uiDiagRes.body.match(/<form|<button|<input|method="post"/i), "No mutating HTML controls");

// 9d. Control Center UI: Enhanced Run Detail page with node selection
const uiRunRes = await app.inject({
  method: "GET",
  url: "/control-center/runs/run.northstar.cr.retry?nodeId=search",
  headers: loopbackHeaders,
});
assert(uiRunRes.statusCode === 200, "UI run detail route returns 200");
assert(uiRunRes.body.includes("Execution Summary (Correlated Runtime &amp; Trace Evidence)"), "Execution summary in HTML");
assert(uiRunRes.body.includes("Workflow Node Execution Map"), "Node map in HTML");
assert(uiRunRes.body.includes("Selected Node Detail"), "Selected node detail in HTML");
assert(uiRunRes.body.includes("search"), "Selected node id rendered");
assert(uiRunRes.body.includes("Chronological Execution Attempts"), "Attempts timeline in HTML");
assert(!uiRunRes.body.match(/<form|<button|<input|method="post"/i), "No mutating HTML controls on run detail");

// 9e. Mutation guard
for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  const mutRes = await app.inject({
    method,
    url: "/control-center/companies/northstar-commerce/packs/aao.company-research@1.0.0",
    headers: loopbackHeaders,
  });
  assert(mutRes.statusCode === 405, `Mutating method ${method} must return 405`);
}

// 9f. Foreign host guard
const foreignRes = await app.inject({
  method: "GET",
  url: "/control-center/companies/northstar-commerce/packs/aao.company-research@1.0.0",
  headers: { host: "evil.example" },
});
assert(foreignRes.statusCode === 403, "Foreign host must return 403");

await app.close();

process.stdout.write("SPRINT_28_GUIDED_INTEGRATION_RUN_INSPECTOR_SMOKE_OK\n");
