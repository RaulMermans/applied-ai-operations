// Sprint 27 compiled smoke: read-only Operator Inspection using compiled package output only.
// No network, API keys, or external databases.
import process from "node:process";
import {
  createCanonicalDemoInspectionSource,
  createOperatorInspectionService,
  findForbiddenInspectionKeys,
} from "@aao/operator-inspection";

const assert = (condition, message) => {
  if (!condition) {
    process.stderr.write(`Smoke Assertion Failed: ${message}\n`);
    throw new Error(message);
  }
};

const service = createOperatorInspectionService(await createCanonicalDemoInspectionSource());

const overview = await service.getOverview();
assert(overview.readOnly === true, "overview must be read-only");
assert(overview.counts.companies === 2 && overview.counts.capabilityPacks === 3, "companies/packs counts");
assert(overview.counts.compatiblePackBindings === 6, "6 verified compatible bindings");

const { packs, compatibility } = await service.listCapabilityPacks();
assert(packs.length === 3, "3 packs");
assert(compatibility.every((c) => c.status === "COMPATIBLE" && c.verified), "compatibility is evidence-backed");

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

const second = await createOperatorInspectionService(await createCanonicalDemoInspectionSource()).getOverview();
assert(JSON.stringify(second) === JSON.stringify(overview), "deterministic output");

process.stdout.write("SPRINT_27_OPERATOR_INSPECTION_SMOKE_OK\n");
