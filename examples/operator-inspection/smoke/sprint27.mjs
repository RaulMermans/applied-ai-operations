// Sprint 27 compiled smoke: read-only Operator Inspection using compiled package output only.
// No network, API keys, or external databases.
import process from "node:process";
import {
  CANONICAL_NORTHSTAR_MANIFEST,
  COMPANY_RESEARCH_PACK,
  createCanonicalDemoInspectionSource,
  createOperatorInspectionService,
  createVerifiedRegistrationEvidenceForCompany,
  findForbiddenInspectionKeys,
  projectPackCompatibilitySummary,
} from "@aao/operator-inspection";
import { buildApp } from "../../../apps/control-plane/dist/app.js";

const assert = (condition, message) => {
  if (!condition) {
    process.stderr.write(`Smoke Assertion Failed: ${message}\n`);
    throw new Error(message);
  }
};

const source = await createCanonicalDemoInspectionSource();
const service = createOperatorInspectionService(source);

// 1. Demo source provenance = DEMO
const prov = await service.getProvenance();
assert(prov.mode === "demo", `Demo source provenance must be DEMO, got ${prov.mode}`);
assert(prov.label.includes("DEMO DATA"), "Provenance label must identify demo data");

// 2. Compatibility status derives from independent proof registration evidence
const overview = await service.getOverview();
assert(overview.readOnly === true, "overview must be read-only");
assert(overview.counts.companies === 2 && overview.counts.capabilityPacks === 3, "companies/packs counts");
assert(overview.counts.unverifiedPackBindings === 6, "all 6 bindings unverified without registration evidence");
assert(overview.counts.compatiblePackBindings === 0, "0 compatible bindings without registration evidence");

const { packs, compatibility } = await service.listCapabilityPacks();
assert(packs.length === 3, "3 packs");
assert(
  compatibility.every((c) => c.status === "NOT_VERIFIED" && !c.verified),
  "compatibility reports NOT_VERIFIED when trusted proof snapshots are absent"
);

// 3. Missing registration snapshot → NOT_VERIFIED
const missingSnapshotSummary = projectPackCompatibilitySummary({
  companyManifest: CANONICAL_NORTHSTAR_MANIFEST,
  pack: COMPANY_RESEARCH_PACK,
  registrationEvidence: undefined,
});
assert(missingSnapshotSummary.status === "NOT_VERIFIED", "missing registration snapshot must produce NOT_VERIFIED");
assert(missingSnapshotSummary.verified === false, "unverified must have verified=false");
assert(missingSnapshotSummary.reasonCode === "PACK_EVIDENCE_UNAVAILABLE", "reasonCode must be PACK_EVIDENCE_UNAVAILABLE");

// 4. Missing registered Tool → INCOMPATIBLE
const driftEvidence = createVerifiedRegistrationEvidenceForCompany("northstar-commerce", {
  company_research: { tools: [] },
});
const driftSummary = projectPackCompatibilitySummary({
  companyManifest: CANONICAL_NORTHSTAR_MANIFEST,
  pack: COMPANY_RESEARCH_PACK,
  registrationEvidence: driftEvidence.company_research,
});
assert(driftSummary.status === "INCOMPATIBLE", "missing registered tool must produce INCOMPATIBLE");
assert(driftSummary.reasonCode === "PACK_REQUIREMENT_MISSING", "reasonCode must be PACK_REQUIREMENT_MISSING");

// Valid independent registration evidence produces COMPATIBLE
const validEvidence = createVerifiedRegistrationEvidenceForCompany("northstar-commerce");
const validSummary = projectPackCompatibilitySummary({
  companyManifest: CANONICAL_NORTHSTAR_MANIFEST,
  pack: COMPANY_RESEARCH_PACK,
  registrationEvidence: validEvidence.company_research,
});
assert(validSummary.status === "COMPATIBLE", "valid registration snapshot must produce COMPATIBLE");
assert(validSummary.verified === true, "verified must be true");

// Workflows, Runs, Approvals, Evaluations baseline checks
const workflows = await service.listWorkflows();
for (const p of packs) {
  const w = workflows.find((x) => x.workflowId === p.workflow.id);
  assert(w && w.planFingerprint === p.workflow.planFingerprint, `plan fingerprint pinned for ${p.identity}`);
}

const runs = await service.listKnownRuns();
const byId = Object.fromEntries(runs.map((r) => [r.runId, r]));
assert(byId["run.northstar.cr.001"].status === "COMPLETED", "completed run");
assert(byId["run.arbor.ops.002"].status === "WAITING", "waiting run");
assert(byId["run.northstar.cr.003"].status === "FAILED", "failed run");
assert(byId["run.arbor.cr.incomplete"].status === "UNKNOWN", "incomplete trace without runtime state is UNKNOWN");

const approval = await service.getApprovalSummary("approval.arbor.ops.002");
assert(approval.status === "pending", "pending approval from authoritative record");

const evals = await service.listKnownEvaluationResults();
assert(evals.some((e) => e.status === "REGISTERED" && !e.executed), "registered profile is not an executed result");
assert(evals.filter((e) => e.status === "PASSED").length === 3, "three passed evaluations");

const trace = await service.getRunTraceInspection("run.northstar.ops.001");
assert(findForbiddenInspectionKeys(trace).length === 0, "trace has no forbidden content");
assert(findForbiddenInspectionKeys(overview).length === 0, "overview has no forbidden content");

let limited = false;
try {
  await service.listKnownRuns({ limit: 100000 });
} catch (err) {
  limited = err.code === "INSPECTION_LIMIT_EXCEEDED";
}
assert(limited, "over-limit request refused");

// 5. Browser HTTP Surface Tests via Fastify app
const app = buildApp({ inspectionSource: source });
const loopbackHeaders = { host: "127.0.0.1:4000" };

// 5a. Known Run link → valid read-only Run detail route
const ccRes = await app.inject({ method: "GET", url: "/control-center", headers: loopbackHeaders });
assert(ccRes.statusCode === 200, "GET /control-center must return 200");
assert(ccRes.body.includes("/control-center/runs/run.northstar.cr.001"), "Known Run link rendered in runs table");
assert(ccRes.body.includes("DEMO DATA — NOT LIVE OPERATIONS"), "Demo indicator visible on Control Center overview");

// 6. Known Run detail → authoritative metadata + timeline
const runDetailRes = await app.inject({
  method: "GET",
  url: "/control-center/runs/run.northstar.cr.001",
  headers: loopbackHeaders,
});
assert(runDetailRes.statusCode === 200, "GET /control-center/runs/:runId must return 200");
assert(runDetailRes.body.includes("COMPLETED"), "authoritative completed status in detail HTML");
assert(runDetailRes.body.includes("authoritative_runtime"), "statusSource authoritative_runtime in detail HTML");
assert(runDetailRes.body.includes("data-section=\"trace-timeline\""), "trace timeline section rendered");
assert(runDetailRes.body.includes("data-event-seq=\"0\""), "trace timeline events rendered");
assert(runDetailRes.body.includes("DEMO DATA — NOT LIVE OPERATIONS"), "demo indicator visible on run detail page");
assert(runDetailRes.body.includes("/control-center"), "link back to overview exists");

// 7. Incomplete Run → UNKNOWN, not RUNNING
const incompleteRes = await app.inject({
  method: "GET",
  url: "/control-center/runs/run.arbor.cr.incomplete",
  headers: loopbackHeaders,
});
assert(incompleteRes.statusCode === 200, "incomplete run detail returns 200");
assert(incompleteRes.body.includes("UNKNOWN"), "incomplete run status is UNKNOWN");
assert(incompleteRes.body.includes("unavailable"), "status source is unavailable");
assert(!incompleteRes.body.includes("run-running"), "incomplete run is not inferred as RUNNING");

// 8. Missing Run → safe 404
const missingRes = await app.inject({
  method: "GET",
  url: "/control-center/runs/run.missing_proof_run",
  headers: loopbackHeaders,
});
assert(missingRes.statusCode === 404, "missing run returns 404");
assert(missingRes.body.includes("INSPECTION_RUN_NOT_FOUND"), "missing run displays INSPECTION_RUN_NOT_FOUND");
assert(!missingRes.body.includes("at "), "no stack trace in missing run response");

// 9. Foreign Host/Origin → refused
const foreignHostRes = await app.inject({
  method: "GET",
  url: "/control-center/runs/run.northstar.cr.001",
  headers: { host: "evil.example" },
});
assert(foreignHostRes.statusCode === 403, "foreign host refused with 403");

const foreignOriginRes = await app.inject({
  method: "GET",
  url: "/control-center/runs/run.northstar.cr.001",
  headers: { ...loopbackHeaders, origin: "https://evil.example" },
});
assert(foreignOriginRes.statusCode === 403, "foreign origin refused with 403");

// 10. Inspection → zero model, Tool, Approval and business mutations
for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  const mutRes = await app.inject({
    method,
    url: "/control-center/runs/run.northstar.cr.001",
    headers: loopbackHeaders,
  });
  assert(mutRes.statusCode === 405, `Mutating method ${method} must return 405`);
}

await app.close();

// Deterministic output check
const second = await createOperatorInspectionService(await createCanonicalDemoInspectionSource()).getOverview();
assert(JSON.stringify(second) === JSON.stringify(overview), "deterministic output");

process.stdout.write("SPRINT_27_OPERATOR_INSPECTION_SMOKE_OK\n");
