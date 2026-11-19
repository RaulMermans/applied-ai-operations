// Sprint 28 compiled smoke: Guided Integration Diagnostics & Advanced Run Inspector.
// Offline, read-only, deterministic execution over compiled package outputs only.
import { readFileSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";
import {
  CANONICAL_NORTHSTAR_MANIFEST,
  COMPANY_RESEARCH_PACK,
  createCanonicalDemoInspectionSource,
  createOperatorInspectionService,
  createVerifiedRegistrationEvidenceForCompany,
  formatAdvancedRunInspectionNodesText,
  formatAdvancedRunInspectionTimelineText,
  formatIntegrationDiagnosticsText,
  formatTokenUsageText,
  getRemediationForCode,
  projectIntegrationDiagnostics,
} from "@aao/operator-inspection";
import { buildApp } from "../../../apps/control-plane/dist/app.js";
import { runInspectCommand } from "../../../packages/framework/dist/cli/inspect.js";

const assert = (condition, message) => {
  if (!condition) {
    process.stderr.write(`Smoke Assertion Failed: ${message}\n`);
    throw new Error(message);
  }
};

process.stdout.write("Running Sprint 28 Compiled Smoke...\n");

// Side-effect instrumentation: every network call during the smoke is counted.
let networkCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => { networkCalls += 1; return realFetch(...args); };

// 1. Diagnostics: Verified Pack -> READY
const nsEvidence = createVerifiedRegistrationEvidenceForCompany("northstar-commerce");
const evidenceBefore = JSON.stringify([CANONICAL_NORTHSTAR_MANIFEST, nsEvidence]);
const readyReport = projectIntegrationDiagnostics({
  companyManifest: CANONICAL_NORTHSTAR_MANIFEST,
  pack: COMPANY_RESEARCH_PACK,
  registrationEvidence: nsEvidence.company_research,
});
assert(readyReport.status === "READY", "Verified pack must produce READY status");
assert(readyReport.requirements.length > 0, "Requirements checklist must be populated");
for (const r of readyReport.requirements) {
  const expected = r.category === "integration" || r.name === "Preliminary Permissions" ? "NOT_VERIFIED" : "SATISFIED";
  assert(r.status === expected, `READY requirement '${r.name}' must be ${expected}, got ${r.status}`);
}
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

// 8a. Single Tool lifecycle -> 1 physical invocation (4 lifecycle events, 1 attempt)
const singleRun = await service.getAdvancedRunInspection("run.northstar.cr.001");
assert(singleRun.authoritativeStatus === "COMPLETED", "Authoritative status COMPLETED");
const singleSearch = singleRun.attempts.find((a) => a.nodeId === "search");
assert(singleSearch && singleSearch.toolPhysicalInvocations === 1, "Single Tool lifecycle -> 1 physical invocation");
assert(singleSearch.evidenceEventIds.length === 4, "Four lifecycle events attach to one attempt");
assert(singleRun.counters.nodeAttempts === 2 && singleRun.counters.toolPhysicalInvocations === 1 && singleRun.counters.modelInvocations === 1, "Single-run counters");
assert(singleRun.counters.traceEvents === singleRun.eventCount && singleRun.eventCount > singleRun.counters.nodeAttempts, "Trace events are not attempts");

// 8b. Explicit retry -> correct attempt and retry counts
const retryRun = await service.getAdvancedRunInspection("run.northstar.cr.retry");
const searchNode = retryRun.nodes.find((n) => n.nodeId === "search");
assert(searchNode && searchNode.executionCount === 1 && searchNode.attemptCount === 2 && searchNode.scheduledRetries === 1, "Explicit retry: 1 execution, 2 attempts, 1 scheduled retry");
assert(searchNode.attempts[0].status === "retried" && searchNode.attempts[1].status === "completed", "Retry attempt outcomes");
assert(retryRun.counters.scheduledRetries === 1 && retryRun.counters.toolPhysicalInvocations === 2, "Retry counters");

// 8c. Repeated node at a different step -> 2 distinct execution occurrences, not a retry
const repeatRun = await service.getAdvancedRunInspection("run.northstar.cr.repeat");
const planNode = repeatRun.nodes.find((n) => n.nodeId === "plan");
assert(planNode && planNode.executionCount === 2 && planNode.scheduledRetries === 0, "Repeated node -> 2 distinct execution occurrences");
assert(new Set(planNode.attempts.map((a) => a.spanId)).size === 2, "Repeated executions keep distinct spans");

// 8d. Partial token evidence -> PARTIAL; unknown field -> not recorded, never 0
assert(repeatRun.tokenUsage.status === "partial", "Partial token evidence -> PARTIAL, not COMPLETE");
assert(repeatRun.tokenUsage.totalTokens === undefined && repeatRun.tokenUsage.knownTotalTokens === 250, "Partial totals are known recorded totals only");
assert(planNode.attempts[1].tokenUsage.status === "unavailable" && planNode.attempts[1].tokenUsage.totalTokens === undefined, "Unknown token field stays undefined");
const repeatText = formatAdvancedRunInspectionNodesText(repeatRun);
assert(repeatText.includes("Token Accounting: PARTIAL (known recorded totals"), "CLI text labels partial totals");
const repeatTimeline = formatAdvancedRunInspectionTimelineText(repeatRun);
assert(repeatTimeline.includes("tokens=NOT RECORDED (0/1 invocations with usage)"), "Unknown token usage -> Not Recorded");
assert(!/total=0\b/.test(repeatText + repeatTimeline), "Unknown token usage is never displayed as 0");

// 8e. Recovery replay keeps its logical identity
const recoveryRun = await service.getAdvancedRunInspection("run.northstar.ops.recovery");
assert(recoveryRun.counters.recoveryReplayAttempts === 1 && recoveryRun.counters.nodeAttempts === 0, "Recovery replay is not a new attempt");
assert(formatAdvancedRunInspectionTimelineText(recoveryRun).includes("(recovery replay)"), "Timeline marks recovery replay");

// 8f. Incomplete run reported as UNKNOWN
const incompleteRun = await service.getAdvancedRunInspection("run.arbor.cr.incomplete");
assert(incompleteRun.authoritativeStatus === "UNKNOWN", "Incomplete run reported as UNKNOWN");
assert(incompleteRun.attempts.every((a) => a.status === "open"), "Incomplete attempt stays open");

// 8g. Redacted summary only -> INSPECTION_SOURCE_UNAVAILABLE (no fabricated Trace)
const redactedService = createOperatorInspectionService({ getProvenance: source.getProvenance, getRunInspection: source.getRunInspection });
let redactedCode;
try { await redactedService.getAdvancedRunInspection("run.northstar.cr.001"); } catch (err) { redactedCode = err.code; }
assert(redactedCode === "INSPECTION_SOURCE_UNAVAILABLE", "Redacted summary only -> INSPECTION_SOURCE_UNAVAILABLE");

// 8h. Missing Tool + missing Eval profile -> both reported MISSING
const multiMissing = projectIntegrationDiagnostics({
  companyManifest: CANONICAL_NORTHSTAR_MANIFEST,
  pack: COMPANY_RESEARCH_PACK,
  registrationEvidence: { ...nsEvidence.company_research, registeredTools: [], registeredEvalProfiles: [] },
});
assert(multiMissing.status === "BLOCKED", "Multi-missing -> BLOCKED");
assert(multiMissing.requirements.filter((r) => r.category === "tool").every((r) => r.status === "MISSING"), "Missing Tool reported MISSING");
assert(multiMissing.requirements.find((r) => r.category === "evaluation").status === "MISSING", "Missing Eval profile reported MISSING alongside the Tool");

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
assert(uiRunRes.body.includes("Node Attempts (2)"), "Node attempts in HTML");
assert(!uiRunRes.body.includes("Total Attempts"), "No ambiguous Total Attempts metric");
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

// 10. CLI = HTTP = UI over one shared source
const blockedEvidence = { "northstar-commerce": { company_research: { ...nsEvidence.company_research, registeredTools: [], registeredEvalProfiles: [] } } };
const sharedSource = await createCanonicalDemoInspectionSource({ includeExtendedRuns: true, registrationEvidenceByCompany: blockedEvidence });
const sharedApp = buildApp({ inspectionSource: sharedSource });
for (const runId of ["run.northstar.cr.retry", "run.northstar.cr.repeat"]) {
  const cli = JSON.parse((await runInspectCommand(["run", runId, "--view", "nodes", "--format", "json"], sharedSource)).output);
  const http = (await sharedApp.inject({ method: "GET", url: `/api/v1/inspection/runs/${runId}/analysis`, headers: loopbackHeaders })).json();
  const html = (await sharedApp.inject({ method: "GET", url: `/control-center/runs/${runId}`, headers: loopbackHeaders })).body;
  assert(JSON.stringify(cli.counters) === JSON.stringify(http.counters), `${runId}: CLI counters = HTTP counters`);
  assert(JSON.stringify(cli.attempts) === JSON.stringify(http.attempts), `${runId}: CLI attempts = HTTP attempts`);
  assert(JSON.stringify(cli.tokenUsage) === JSON.stringify(http.tokenUsage), `${runId}: CLI token accounting = HTTP token accounting`);
  const uiCounter = (label) => html.match(new RegExp(`data-counter="${label}">\\s*<div class="label">[^<]*</div>\\s*<div class="value-id">([^<]*)</div>`))?.[1];
  assert(uiCounter("Node Attempts") === String(http.counters.nodeAttempts), `${runId}: UI Node Attempts = HTTP`);
  assert(uiCounter("Scheduled Retries") === String(http.counters.scheduledRetries), `${runId}: UI Scheduled Retries = HTTP`);
  assert(uiCounter("Tool Physical Invocations") === String(http.counters.toolPhysicalInvocations), `${runId}: UI Tool Physical Invocations = HTTP`);
  assert(uiCounter("Token Accounting") === formatTokenUsageText(http.tokenUsage), `${runId}: UI token accounting = HTTP`);
  const cliText = (await runInspectCommand(["run", runId, "--view", "nodes"], sharedSource)).output;
  assert(cliText.includes(`Node Attempts: ${http.counters.nodeAttempts}`) && cliText.includes(`Token Accounting: ${formatTokenUsageText(http.tokenUsage)}`), `${runId}: CLI text = HTTP`);
}
const cliReadiness = JSON.parse((await runInspectCommand(["readiness", "--company", "northstar-commerce", "--pack", "aao.company-research@1.0.0", "--format", "json"], sharedSource)).output);
const httpReadiness = (await sharedApp.inject({ method: "GET", url: "/api/v1/inspection/companies/northstar-commerce/packs/aao.company-research@1.0.0/diagnostics", headers: loopbackHeaders })).json();
const uiReadiness = (await sharedApp.inject({ method: "GET", url: "/control-center/companies/northstar-commerce/packs/aao.company-research@1.0.0", headers: loopbackHeaders })).body;
const statuses = (report) => report.requirements.map((r) => `${r.requiredRef}=${r.status}`).join("|");
assert(statuses(cliReadiness) === statuses(httpReadiness), "CLI requirement statuses = HTTP");
const uiStatuses = [...uiReadiness.matchAll(/data-requirement-ref="([^"]*)" data-requirement-status="([^"]*)"/g)].map((m) => `${m[1].replace(/&gt;/g, ">")}=${m[2]}`).join("|");
assert(uiStatuses === statuses(httpReadiness), "UI requirement statuses = HTTP");
assert(httpReadiness.requirements.filter((r) => r.status === "MISSING").length >= 2, "Shared source reports both missing requirements");
await sharedApp.close();

// 11. Zero side effects (measured)
assert(networkCalls === 0, "Inspection -> zero network/provider calls");
assert(JSON.stringify([CANONICAL_NORTHSTAR_MANIFEST, nsEvidence]) === evidenceBefore, "Inspection -> zero evidence/config mutations");
const inspectionDeps = Object.keys(JSON.parse(readFileSync(new URL("../../../packages/operator-inspection/package.json", import.meta.url), "utf8")).dependencies);
for (const dep of ["@aao/runtime", "@aao/model-runtime", "@aao/tool-runtime", "@aao/approval", "@aao/evaluation", "@aao/durability"]) {
  assert(!inspectionDeps.includes(dep), `Inspection cannot reach ${dep} (zero model/Tool/approval/business-write capability)`);
}
globalThis.fetch = realFetch;

process.stdout.write("SPRINT_28_GUIDED_INTEGRATION_RUN_INSPECTOR_SMOKE_OK\n");
