import { describe, expect, it } from "vitest";
import { evaluate, type EvalEvidenceBundle } from "../src/index.js";
import { realAuthorizationDenied, realFlagship } from "./support/fixture-builders.js";
import { definition, loadFixture, registry } from "./support/evals.js";
import { def, grade, verdict } from "./support/inline.js";
import { APPROVAL_SUBJECT_SECRET, STATE_SECRET, TOOL_OUTPUT_SECRET } from "./support/world.js";

/**
 * RUNTIME mode: the host runs a real AAO workflow, the Runtime returns at a
 * terminal (or safe) boundary, and only then does the host hand the evidence
 * to the Evaluation Runtime. Evaluation is outside the Runtime loop and
 * read-only: execution, Approval, Tool, Trace, and Audit state are
 * identical before and after.
 */
async function snapshotWorld(run: Awaited<ReturnType<typeof realFlagship>>) {
  const runId = run.bundle.runId!;
  return JSON.stringify({
    execution: run.execution,
    calls: run.world.calls,
    trace: await run.world.store.getRunTrace(runId),
    audit: await run.world.auditStore.getStream(`run:${runId}`),
    approval: run.execution.history.length > 0 ? run.world.approvals.getApproval((run.bundle.trace as Array<{ type: string; payload: { approvalId?: string } }>).find((event) => event.type === "approval.requested")?.payload.approvalId ?? "none") ?? null : null,
    traceHealth: run.world.recorder.health(),
    auditHealth: run.world.audit.health(),
  });
}

describe("RUNTIME evaluation of a real Run: prepare → approval → retry-safe Tool → final", () => {
  it("run outcome, required Tool, Approval, retries ≤ 1, state, Metrics, and Trace contract all pass — and nothing changes", async () => {
    const run = await realFlagship("approve", "live_run", "run.live.flagship");
    expect(run.execution.run.status).toBe("COMPLETED");
    const before = await snapshotWorld(run);

    const definitions = [
      definition("run.completed"),
      definition("tool.lookup-required"),
      definition("approval.required-and-approved"),
      definition("retry.within-budget"),
      definition("state.flagship-final"),
      definition("metrics.operational-budget"),
      definition("trajectory.flagship-exact"),
      definition("authorization.denials-enforced"),
      def("aao.trace-contract", "run", { requireTerminal: true, expectedRunStatus: "COMPLETED", compareWithExecution: true }),
      def("aao.authorization-compliance", "authorization", { deniedNeverExecuted: false, crossCheckAudit: true }),
    ];
    const results = [];
    for (const candidate of definitions) results.push(await evaluate({ definition: candidate, mode: "RUNTIME", evidence: run.bundle, registry: registry() }));

    expect(results.map((result) => [result.evalRef.id, result.status, result.errorCode ?? null])).toEqual([
      ["run.completed", "passed", null],
      ["tool.lookup-required", "passed", null],
      ["approval.required-and-approved", "passed", null],
      ["retry.within-budget", "passed", null],
      ["state.flagship-final", "passed", null],
      ["metrics.operational-budget", "passed", null],
      ["trajectory.flagship-exact", "passed", null],
      // No denial occurred in this Run: the denial rule has nothing to judge, so it is an error, never a vacuous pass.
      ["authorization.denials-enforced", "error", "EVAL_EVIDENCE_MISSING"],
      ["test.trace-contract", "passed", null],
      ["test.authorization-compliance", "passed", null],
    ]);
    for (const result of results) expect(result).toMatchObject({ mode: "RUNTIME", runId: "run.live.flagship" });
    expect(await snapshotWorld(run)).toBe(before);
  });

  it("the same graders judge the same evidence identically in OFFLINE and RUNTIME mode (no mode-specific grader logic)", async () => {
    const run = await realFlagship("approve", "live_run", "run.live.modes");
    for (const id of ["tool.lookup-required", "approval.required-and-approved", "state.flagship-final"]) {
      const live = await evaluate({ definition: definition(id), mode: "RUNTIME", evidence: run.bundle, registry: registry() });
      const offline = await evaluate({ definition: definition(id), mode: "OFFLINE", evidence: { ...run.bundle, origin: "recorded" }, registry: registry() });
      expect(offline.assertions).toEqual(live.assertions);
      expect(offline.status).toBe(live.status);
      expect(offline.evidenceFingerprint).toBe(live.evidenceFingerprint);
      expect(offline.resultId).not.toBe(live.resultId);
    }
  });

  it("state assertions compare values without copying them (revision == N, exists, equals, not-exists)", async () => {
    const run = await realFlagship("approve", "live_run", "run.live.state");
    const result = await evaluate({ definition: definition("state.flagship-final"), mode: "RUNTIME", evidence: run.bundle, registry: registry() });
    expect(verdict(result)).toEqual({ status: "passed", failed: [] });
    expect(result.assertions.every((entry) => entry.evidenceRefs[0] === "execution://run.live.state/state-revision/2")).toBe(true);
    const failing = await grade(def("aao.state-assertion", "state", { checks: [{ id: "secret-is-other", op: "path_equals", path: "/internal/credential", value: "other" }] }), run.bundle);
    expect(verdict(failing)).toEqual({ status: "failed", failed: ["state:secret-is-other:STATE_ASSERTION_FAILED"] });
    for (const secret of [STATE_SECRET, TOOL_OUTPUT_SECRET, APPROVAL_SUBJECT_SECRET, "account-a"]) expect(JSON.stringify([result, failing])).not.toContain(secret);
  });

  it("metrics thresholds from real Trace-derived Metrics: within 30 s passes, 20 s fails", async () => {
    const run = await realFlagship("approve", "live_run", "run.live.metrics");
    const metrics = run.bundle.metrics as { durationMs: number; retries: { scheduled: number }; tools: { physicalInvocations: number } };
    expect([metrics.durationMs, metrics.retries.scheduled, metrics.tools.physicalInvocations]).toEqual([23000, 1, 2]);
    expect((await grade(def("aao.metrics-threshold", "run", { maxRunDurationMs: 30000, maxRetries: 1, maxPhysicalToolCalls: 2 }), run.bundle)).status).toBe("passed");
    expect(verdict(await grade(def("aao.metrics-threshold", "run", { maxRunDurationMs: 20000, maxRetries: 1, maxPhysicalToolCalls: 2 }), run.bundle))).toEqual({ status: "failed", failed: ["metrics.run-duration:METRIC_THRESHOLD_EXCEEDED"] });
  });
});

describe("Permission, Approval, and retry E2Es: real evidence passes, negative evidence fails", () => {
  it("authorization denied → tool.call.blocked, handler calls = 0 → passed; started-after-denial evidence → failed", async () => {
    const run = await realAuthorizationDenied("live_run");
    expect(run.world.calls).toHaveLength(0);
    const result = await evaluate({ definition: definition("authorization.denial-respected"), mode: "RUNTIME", evidence: run.bundle, registry: registry() });
    expect(verdict(result)).toEqual({ status: "passed", failed: [] });
    const negative = await grade(definition("authorization.denials-enforced"), loadFixture("negative-denied-then-executed"));
    expect(verdict(negative)).toEqual({ status: "failed", failed: ["authorization.denied-not-executed:AUTHORIZATION_DENIAL_NOT_ENFORCED"] });
    expect(run.world.calls).toHaveLength(0);
  });

  it("approval rejected → Run fails, downstream Tool calls = 0 → passed; Tool after rejection → failed", async () => {
    const run = await realFlagship("reject", "live_run", "run.live.rejected");
    expect(run.execution.run.status).toBe("FAILED");
    expect(run.world.calls).toHaveLength(0);
    for (const id of ["approval.no-tool-after-rejection", "run.failed-on-approval-rejection", "trajectory.no-lookup-node"]) {
      expect(verdict(await evaluate({ definition: definition(id), mode: "RUNTIME", evidence: run.bundle, registry: registry() })), id).toEqual({ status: "passed", failed: [] });
    }
    expect(verdict(await grade(definition("approval.no-tool-after-rejection"), loadFixture("negative-tool-after-rejection")))).toEqual({ status: "failed", failed: ["approval.no-tool-after-rejection:TOOL_AFTER_REJECTED_APPROVAL"] });
    expect(verdict(await grade(definition("approval.no-bypass"), loadFixture("negative-approval-bypass")))).toEqual({ status: "failed", failed: ["approval.no-tool-before-approval:APPROVAL_BYPASSED"] });
  });

  it("authorization failure with maxAttempts 3 → retry.scheduled = 0 → passed; retry after denial → failed", async () => {
    const run = await realAuthorizationDenied("live_run");
    const policies = ((run.bundle.trace as Array<{ type: string; payload: { reliabilityPolicies?: unknown } }>)[0]!.payload.reliabilityPolicies);
    expect(policies).toEqual([{ nodeId: "lookup", maxAttempts: 3 }]);
    expect(verdict(await evaluate({ definition: definition("retry.authorization-not-retried"), mode: "RUNTIME", evidence: run.bundle, registry: registry() }))).toEqual({ status: "passed", failed: [] });
    expect(verdict(await grade(definition("retry.authorization-not-retried"), loadFixture("negative-retry-after-denial")))).toEqual({ status: "failed", failed: ["retry.count:RETRY_COUNT_MISMATCH", "retry.forbidden-category:RETRY_FORBIDDEN_CATEGORY"] });
  });

  it("negative evidence (forbidden Tool call) → failed with deterministic assertion evidence; the evidence is not altered", async () => {
    const evidence = loadFixture("negative-forbidden-tool");
    const before = JSON.stringify(evidence);
    const a = await grade(definition("tool.no-external-send"), evidence);
    const b = await grade(definition("tool.no-external-send"), evidence);
    expect(a).toEqual(b);
    expect(a.assertions).toEqual([{ id: "tool.forbidden:external.send-email:1.0.0", status: "failed", reasonCode: "TOOL_FORBIDDEN_INVOKED", evidenceRefs: ["trace://run.eval.forbidden/event/8"] }]);
    expect(JSON.stringify(evidence)).toBe(before);
  });
});

describe("failed vs error are never conflated", () => {
  it("behavior violation → failed; missing / corrupt / incomplete evidence → error; grader or judge exception → error", async () => {
    const cases: Array<[string, EvalEvidenceBundle, string, string?]> = [
      ["tool.no-external-send", loadFixture("negative-forbidden-tool"), "failed"],
      ["tool.no-external-send", loadFixture("corrupt-trace-gap"), "error", "EVAL_EVIDENCE_INVALID"],
      ["tool.no-external-send", loadFixture("execution-only"), "error", "EVAL_EVIDENCE_MISSING"],
      ["metrics.cost-budget", loadFixture("metrics-cost-unavailable"), "error", "EVAL_REQUIRED_EVIDENCE_INCOMPLETE"],
    ];
    for (const [id, evidence, status, errorCode] of cases) {
      const result = await grade(definition(id), evidence);
      expect([result.status, result.errorCode ?? null], id).toEqual([status, errorCode ?? null]);
    }
  });
});
