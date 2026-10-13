import { describe, expect, it } from "vitest";
import { executeWorkflow } from "@aao/runtime";
import { deriveRunMetrics } from "@aao/observability";
import type { EvalEvidenceBundle } from "../src/index.js";
import { loadFixture } from "./support/evals.js";
import { def, grade, verdict } from "./support/inline.js";
import { TRANSIENT, compile, toolYaml, world } from "./support/world.js";

const LOOKUP = { id: "local.lookup", version: "1.0.0" };
const SEND = { id: "external.send-email", version: "1.0.0" };
const approved = () => loadFixture("flagship-approved");
const rejected = () => loadFixture("approval-rejected");
const denied = () => loadFixture("authorization-denied");
const pending = () => loadFixture("approval-pending");
const withoutTerminal = (bundle: EvalEvidenceBundle): EvalEvidenceBundle => ({ ...bundle, trace: bundle.trace!.slice(0, 12), execution: undefined, metrics: undefined, audit: undefined });

describe("aao.trace-contract (reuses validateTrace / compareTraceWithExecution)", () => {
  const contract = (config = {}) => def("aao.trace-contract", "run", config);

  it("valid and complete → passed; corrupt → failed with the canonical diagnostic code; absent → error", async () => {
    expect(verdict(await grade(contract(), approved()))).toEqual({ status: "passed", failed: [] });
    expect(verdict(await grade(contract(), loadFixture("corrupt-trace-gap")))).toEqual({ status: "failed", failed: ["trace.valid:TRACE_SEQUENCE_GAP"] });
    expect(verdict(await grade(contract(), loadFixture("execution-only")))).toEqual({ status: "error", errorCode: "EVAL_EVIDENCE_MISSING", failed: [] });
  });

  it("a trace without a terminal event fails the completeness criterion unless the definition judges a wait boundary", async () => {
    expect(verdict(await grade(contract(), pending()))).toEqual({ status: "failed", failed: ["trace.terminal:TRACE_TERMINAL_EVENT_MISSING"] });
    expect(verdict(await grade(contract({ requireTerminal: false, expectedRunStatus: "WAITING_FOR_APPROVAL" }), pending()))).toEqual({ status: "passed", failed: [] });
    expect(verdict(await grade(contract({ requireTerminal: true, expectedRunStatus: "WAITING_FOR_APPROVAL" }), pending()))).toMatchObject({ status: "error", errorCode: "EVAL_INVALID_DEFINITION" });
  });

  it("lifecycle coherence against Runtime execution evidence", async () => {
    expect(verdict(await grade(contract({ compareWithExecution: true }), approved()))).toEqual({ status: "passed", failed: [] });
    const bundle = approved();
    const drifted = { ...bundle, execution: { ...bundle.execution!, state: { ...bundle.execution!.state, revision: 7 } } };
    expect(verdict(await grade(contract({ compareWithExecution: true }), drifted))).toEqual({ status: "failed", failed: ["trace.matches-execution:TRACE_STATE_MISMATCH"] });
    expect(verdict(await grade(contract({ compareWithExecution: true }), { ...bundle, execution: undefined }))).toMatchObject({ status: "error", errorCode: "EVAL_EVIDENCE_MISSING" });
  });
});

describe("aao.run-outcome", () => {
  it("expected / forbidden status and failure code from evidence", async () => {
    expect(verdict(await grade(def("aao.run-outcome", "run", { expectedStatus: "COMPLETED" }), approved()))).toEqual({ status: "passed", failed: [] });
    expect(verdict(await grade(def("aao.run-outcome", "run", { expectedStatus: "COMPLETED" }), rejected()))).toEqual({ status: "failed", failed: ["run.status:RUN_STATUS_MISMATCH"] });
    expect(verdict(await grade(def("aao.run-outcome", "run", { forbiddenStatuses: ["FAILED"] }), denied()))).toEqual({ status: "failed", failed: ["run.status-not-forbidden:RUN_STATUS_FORBIDDEN"] });
    expect(verdict(await grade(def("aao.run-outcome", "run", { expectedStatus: "FAILED", expectedFailureCategory: "AUTHORIZATION" }), denied()))).toEqual({ status: "passed", failed: [] });
    expect(verdict(await grade(def("aao.run-outcome", "run", { expectedStatus: "WAITING_FOR_APPROVAL" }), pending()))).toEqual({ status: "passed", failed: [] });
  });

  it("Runtime state and Trace must agree; a Run that has not reached a boundary is not judged", async () => {
    const bundle = approved();
    const disagree = { ...bundle, execution: { ...bundle.execution!, run: { ...bundle.execution!.run, status: "FAILED" as const } } };
    expect(verdict(await grade(def("aao.run-outcome", "run", { expectedStatus: "COMPLETED" }), disagree))).toMatchObject({ status: "error", errorCode: "EVAL_EVIDENCE_INVALID" });
    const running = { ...withoutTerminal(bundle), trace: bundle.trace!.slice(0, 4) };
    expect(verdict(await grade(def("aao.run-outcome", "run", { forbiddenStatuses: ["FAILED"] }), running))).toMatchObject({ status: "error", errorCode: "EVAL_REQUIRED_EVIDENCE_INCOMPLETE" });
    expect(verdict(await grade(def("aao.run-outcome", "run", {}), bundle))).toMatchObject({ status: "error", errorCode: "EVAL_INVALID_DEFINITION" });
  });
});

describe("aao.trajectory (explicit sequence semantics)", () => {
  it("exact vs ordered_subsequence", async () => {
    expect((await grade(def("aao.trajectory", "trajectory", { nodeSequence: { mode: "exact", nodes: ["prepare", "approval", "lookup", "final"] } }), approved())).status).toBe("passed");
    expect(verdict(await grade(def("aao.trajectory", "trajectory", { nodeSequence: { mode: "exact", nodes: ["prepare", "lookup", "final"] } }), approved()))).toEqual({ status: "failed", failed: ["trajectory.node-sequence:TRAJECTORY_NODE_SEQUENCE_MISMATCH"] });
    expect((await grade(def("aao.trajectory", "trajectory", { nodeSequence: { mode: "ordered_subsequence", nodes: ["prepare", "final"] } }), approved())).status).toBe("passed");
    expect(verdict(await grade(def("aao.trajectory", "trajectory", { nodeSequence: { mode: "ordered_subsequence", nodes: ["final", "prepare"] } }), approved()))).toEqual({ status: "failed", failed: ["trajectory.node-sequence:TRAJECTORY_NODE_SEQUENCE_MISMATCH"] });
  });

  it("retries do not repeat a step in the Node trajectory; forbidden events are canonical event patterns", async () => {
    expect((await grade(def("aao.trajectory", "trajectory", { eventSequence: { mode: "ordered_subsequence", events: [{ type: "approval.resolved" }, { type: "retry.scheduled", nodeId: "lookup" }, { type: "run.completed" }] } }), approved())).status).toBe("passed");
    expect(verdict(await grade(def("aao.trajectory", "trajectory", { forbiddenEvents: [{ type: "tool.call.failed" }] }), approved()))).toEqual({ status: "failed", failed: ["trajectory.forbidden-event:1:TRAJECTORY_FORBIDDEN_EVENT"] });
    expect(verdict(await grade(def("aao.trajectory", "trajectory", { forbiddenEvents: [{ type: "lookup.regex.*" }] }), approved()))).toMatchObject({ status: "error", errorCode: "EVAL_INVALID_DEFINITION" });
  });

  it("forbidden-behavior checks need the whole Run (no false pass on a partial trace)", async () => {
    expect(verdict(await grade(def("aao.trajectory", "trajectory", { forbiddenNodes: ["lookup"] }), pending()))).toMatchObject({ status: "error", errorCode: "EVAL_REQUIRED_EVIDENCE_INCOMPLETE" });
  });
});

describe("aao.tool-usage", () => {
  const usage = (config: object) => def("aao.tool-usage", "tool_use", config as never);

  it("required Tool: invoked → passed; only blocked → failed (blocked is not invocation)", async () => {
    expect((await grade(usage({ requiredTools: [LOOKUP] }), approved())).status).toBe("passed");
    expect(verdict(await grade(usage({ requiredTools: [LOOKUP] }), denied()))).toEqual({ status: "failed", failed: ["tool.required:local.lookup:1.0.0:TOOL_NOT_INVOKED"] });
  });

  it("forbidden Tool: started → failed; blocked only → passed, citing the block as evidence", async () => {
    expect(verdict(await grade(usage({ forbiddenTools: [SEND] }), loadFixture("negative-forbidden-tool")))).toEqual({ status: "failed", failed: ["tool.forbidden:external.send-email:1.0.0:TOOL_FORBIDDEN_INVOKED"] });
    const blockedOnly = await grade(usage({ forbiddenTools: [LOOKUP] }), denied());
    expect(blockedOnly.status).toBe("passed");
    expect(blockedOnly.assertions[0]!.evidenceRefs).toEqual(["trace://run.eval.denied/event/2"]);
  });

  it("physical and logical counts stay distinct (retry: 2 physical / 1 logical; crash replay: 2 / 1)", async () => {
    expect(verdict(await grade(usage({ callLimits: [{ tool: LOOKUP, count: "physical", max: 1 }] }), approved()))).toEqual({ status: "failed", failed: ["tool.limit:physical:local.lookup:1.0.0:TOOL_CALL_LIMIT_EXCEEDED"] });
    expect((await grade(usage({ callLimits: [{ tool: LOOKUP, count: "logical", max: 1 }] }), approved())).status).toBe("passed");
    expect((await grade(usage({ callLimits: [{ count: "physical", min: 2, max: 2 }, { count: "logical", min: 1, max: 1 }] }), loadFixture("durable-replay"))).status).toBe("passed");
    expect(verdict(await grade(usage({ callLimits: [{ count: "logical", min: 2 }] }), loadFixture("durable-replay")))).toEqual({ status: "failed", failed: ["tool.limit:logical:all:TOOL_CALL_MINIMUM_NOT_MET"] });
  });

  it("ordering, blocked expectation, failure expectation", async () => {
    const forbidden = loadFixture("negative-forbidden-tool");
    expect((await grade(usage({ requiredOrder: [LOOKUP, SEND] }), forbidden)).status).toBe("passed");
    expect(verdict(await grade(usage({ requiredOrder: [SEND, LOOKUP] }), forbidden))).toEqual({ status: "failed", failed: ["tool.order:TOOL_ORDER_VIOLATED"] });
    expect(verdict(await grade(usage({ expectedBlocked: [{ tool: LOOKUP }] }), approved()))).toEqual({ status: "failed", failed: ["tool.blocked:local.lookup:1.0.0:TOOL_NOT_BLOCKED"] });
    expect(verdict(await grade(usage({ expectedBlocked: [{ tool: LOOKUP }] }), loadFixture("negative-denied-then-executed")))).toEqual({ status: "failed", failed: ["tool.blocked:local.lookup:1.0.0:TOOL_EXECUTED_AFTER_BLOCK"] });
    expect((await grade(usage({ expectedFailures: [{ tool: LOOKUP, failureCode: "UPSTREAM_UNAVAILABLE" }] }), approved())).status).toBe("passed");
    expect(verdict(await grade(usage({ expectedFailures: [{ tool: LOOKUP }] }), loadFixture("durable-replay")))).toEqual({ status: "failed", failed: ["tool.failed:local.lookup:1.0.0:TOOL_FAILURE_NOT_OBSERVED"] });
  });

  it("rejects ambiguous config (required and forbidden, duplicates, no criterion)", async () => {
    for (const config of [{ requiredTools: [LOOKUP], forbiddenTools: [LOOKUP] }, { requiredTools: [LOOKUP, LOOKUP] }, {}, { requiredTools: [{ id: "local.lookup" }] }]) {
      expect((await grade(usage(config), approved())).errorCode).toBe("EVAL_INVALID_DEFINITION");
    }
  });
});

describe("aao.approval-compliance", () => {
  const approval = (config: object) => def("aao.approval-compliance", "approval", config as never);

  it("required, exactly once, resolution, no Tool before approval", async () => {
    expect((await grade(approval({ approvalRequired: true, expectedRequestCount: 1, expectedResolution: "approved", noToolBeforeApproval: true }), approved())).status).toBe("passed");
    expect(verdict(await grade(approval({ approvalRequired: true, expectedResolution: "approved" }), rejected()))).toEqual({ status: "failed", failed: ["approval.resolution:APPROVAL_RESOLUTION_MISMATCH"] });
    expect(verdict(await grade(approval({ approvalRequired: true }), denied()))).toEqual({ status: "failed", failed: ["approval.requested:APPROVAL_NOT_REQUESTED"] });
    expect(verdict(await grade(approval({ approvalRequired: true, noToolBeforeApproval: true }), loadFixture("negative-approval-bypass")))).toEqual({ status: "failed", failed: ["approval.no-tool-before-approval:APPROVAL_BYPASSED"] });
  });

  it("'approval must not occur' is an explicit check, not an inference from missing evidence", async () => {
    expect((await grade(approval({ approvalRequired: false }), denied())).status).toBe("passed");
    expect(verdict(await grade(approval({ approvalRequired: false }), approved()))).toEqual({ status: "failed", failed: ["approval.not-requested:APPROVAL_UNEXPECTED"] });
  });

  it("rejection: zero downstream Tool calls passes; a Tool after rejection fails; no rejection at all is an error", async () => {
    const rule = approval({ approvalRequired: true, expectedResolution: "rejected", noToolAfterNonApproval: true });
    expect((await grade(rule, rejected())).status).toBe("passed");
    expect(verdict(await grade(rule, loadFixture("negative-tool-after-rejection")))).toEqual({ status: "failed", failed: ["approval.no-tool-after-rejection:TOOL_AFTER_REJECTED_APPROVAL"] });
    expect(verdict(await grade(approval({ approvalRequired: true, noToolAfterNonApproval: true }), approved()))).toMatchObject({ status: "error", errorCode: "EVAL_EVIDENCE_MISSING" });
  });

  it("Audit cross-check: consistent → passed; missing Audit → error; a valid but incomplete Audit stream → failed", async () => {
    const rule = approval({ approvalRequired: true, crossCheckAudit: true });
    expect((await grade(rule, approved())).status).toBe("passed");
    expect(verdict(await grade(rule, { ...approved(), audit: undefined }))).toMatchObject({ status: "error", errorCode: "EVAL_EVIDENCE_MISSING" });
    const bundle = approved();
    expect(verdict(await grade(rule, { ...bundle, audit: bundle.audit!.slice(0, 1) }))).toEqual({ status: "failed", failed: ["approval.audit-consistent:APPROVAL_AUDIT_MISMATCH"] });
    const tampered = JSON.parse(JSON.stringify(bundle.audit)) as Array<{ payload: { decision?: string } }>;
    tampered[1]!.payload.decision = "rejected";
    expect(verdict(await grade(rule, { ...bundle, audit: tampered }))).toMatchObject({ status: "error", errorCode: "EVAL_EVIDENCE_INVALID" });
  });

  it("a pending Approval is judged at the wait boundary only when the definition says so", async () => {
    expect((await grade(approval({ approvalRequired: true, expectedResolution: "pending", requireTerminal: false }), pending())).status).toBe("passed");
    expect((await grade(approval({ approvalRequired: true, expectedResolution: "pending" }), pending())).errorCode).toBe("EVAL_INVALID_DEFINITION");
  });
});

describe("aao.authorization-compliance (judges recorded evidence; never re-runs Authorization)", () => {
  const authz = (config: object) => def("aao.authorization-compliance", "authorization", config as never);

  it("denial respected with zero handler starts → passed; a start after the denial → failed", async () => {
    expect((await grade(authz({ expectedDenials: [{ tool: LOOKUP, reasonCode: "PERMISSION_NOT_GRANTED" }], crossCheckAudit: true }), denied())).status).toBe("passed");
    expect(verdict(await grade(authz({}), loadFixture("negative-denied-then-executed")))).toEqual({ status: "failed", failed: ["authorization.denied-not-executed:AUTHORIZATION_DENIAL_NOT_ENFORCED"] });
    expect(verdict(await grade(authz({ expectedDenials: [{ tool: LOOKUP }] }), loadFixture("negative-denied-then-executed")))).toEqual({ status: "failed", failed: ["authorization.denied:local.lookup:1.0.0:AUTHORIZATION_DENIAL_NOT_ENFORCED", "authorization.denied-not-executed:AUTHORIZATION_DENIAL_NOT_ENFORCED"] });
  });

  it("an expected denial that did not happen is failed; nothing to judge is an error", async () => {
    expect(verdict(await grade(authz({ expectedDenials: [{ tool: LOOKUP }] }), approved()))).toEqual({ status: "failed", failed: ["authorization.denied:local.lookup:1.0.0:AUTHORIZATION_DENIAL_EXPECTED"] });
    expect(verdict(await grade(authz({ deniedNeverExecuted: true }), approved()))).toMatchObject({ status: "error", errorCode: "EVAL_EVIDENCE_MISSING" });
  });

  it("allowed access is coherent with Audit; a handler start without an Audit allow is failed", async () => {
    expect((await grade(authz({ crossCheckAudit: true }), approved())).status).toBe("passed");
    const bundle = approved();
    expect(verdict(await grade(authz({ crossCheckAudit: true }), { ...bundle, audit: bundle.audit!.slice(0, 3) }))).toEqual({ status: "failed", failed: ["authorization.audit-consistent:AUTHORIZATION_AUDIT_MISMATCH"] });
  });
});

describe("aao.retry-behavior (from retry.scheduled / retry.exhausted)", () => {
  const retry = (config: object) => def("aao.retry-behavior", "run", config as never);

  it("exact, max, no-retry", async () => {
    expect((await grade(retry({ expectedRetries: 1 }), approved())).status).toBe("passed");
    expect(verdict(await grade(retry({ expectedRetries: 0 }), approved()))).toEqual({ status: "failed", failed: ["retry.count:RETRY_COUNT_MISMATCH"] });
    expect(verdict(await grade(retry({ maxRetries: 0, nodeId: "lookup" }), approved()))).toEqual({ status: "failed", failed: ["retry.max:RETRY_LIMIT_EXCEEDED"] });
    expect((await grade(retry({ maxRetries: 0, nodeId: "prepare" }), approved())).status).toBe("passed");
  });

  it("authorization failure with maxAttempts 3 is never retried; the rule needs such a failure to be judged", async () => {
    expect((await grade(retry({ noRetryForCategories: ["AUTHORIZATION"], expectedRetries: 0 }), denied())).status).toBe("passed");
    expect(verdict(await grade(retry({ noRetryForCategories: ["AUTHORIZATION"] }), loadFixture("negative-retry-after-denial")))).toEqual({ status: "failed", failed: ["retry.forbidden-category:RETRY_FORBIDDEN_CATEGORY"] });
    expect(verdict(await grade(retry({ noRetryForCategories: ["AUTHORIZATION"] }), approved()))).toMatchObject({ status: "error", errorCode: "EVAL_EVIDENCE_MISSING" });
  });

  it("retry exhaustion expected: proven from a real Run that exhausts its budget", async () => {
    const w = world({ plan: compile(toolYaml), toolScript: [TRANSIENT, TRANSIENT, TRANSIENT], reliability: { policiesByNodeId: { lookup: { maxAttempts: 3 } } } });
    const runId = "run.eval.exhausted";
    await executeWorkflow({ runId, plan: w.plan, registry: w.registry, initialState: { runId, revision: 0, values: { proposal: {} } }, options: w.runtimeOptions });
    const bundle: EvalEvidenceBundle = { origin: "live_run", runId, trace: await w.store.getRunTrace(runId) };
    expect((await grade(retry({ expectExhausted: true, expectedRetries: 2 }), bundle)).status).toBe("passed");
    expect(verdict(await grade(retry({ expectExhausted: false }), bundle))).toEqual({ status: "failed", failed: ["retry.exhaustion:RETRY_EXHAUSTED_UNEXPECTEDLY"] });
    expect(verdict(await grade(retry({ expectExhausted: true }), approved()))).toEqual({ status: "failed", failed: ["retry.exhaustion:RETRY_NOT_EXHAUSTED"] });
  });
});

describe("aao.state-assertion (bounded operators, JSON Pointer)", () => {
  const state = (checks: object[]) => def("aao.state-assertion", "state", { checks } as never);

  it("revision, exists, not-exists, equals", async () => {
    const result = await grade(state([
      { id: "rev", op: "revision_equals", revision: 2 },
      { id: "exists", op: "path_exists", path: "/proposal/target" },
      { id: "absent", op: "path_not_exists", path: "/proposal/missing" },
      { id: "equals", op: "path_equals", path: "/lookupResult/output", value: { account: "account-a", apiKeyEcho: "FIXTURE_TOOL_OUTPUT_SECRET_api_key_0123" } },
      { id: "escaped", op: "path_not_exists", path: "/a~1b" },
    ]), loadFixture("execution-only"));
    expect(verdict(result)).toEqual({ status: "passed", failed: [] });
    expect(verdict(await grade(state([{ id: "rev", op: "revision_equals", revision: 1 }, { id: "eq", op: "path_equals", path: "/proposal/target", value: "account-b" }]), loadFixture("execution-only")))).toEqual({ status: "failed", failed: ["state:rev:STATE_ASSERTION_FAILED", "state:eq:STATE_ASSERTION_FAILED"] });
  });

  it("requires execution evidence, and rejects expressions or invalid pointers", async () => {
    expect((await grade(state([{ id: "rev", op: "revision_equals", revision: 2 }]), loadFixture("negative-forbidden-tool"))).errorCode).toBe("EVAL_EVIDENCE_MISSING");
    for (const check of [{ id: "x", op: "path_exists", path: "values.proposal" }, { id: "x", op: "eval", expression: "state.revision > 1" }, { id: "x", op: "path_matches", path: "/a", pattern: ".*" }]) {
      expect((await grade(state([check]), loadFixture("execution-only"))).errorCode).toBe("EVAL_INVALID_DEFINITION");
    }
  });
});

describe("aao.metrics-threshold (missing measurement is not compliance)", () => {
  const metrics = (config: object) => def("aao.metrics-threshold", "run", config as never);

  it("duration 23 s, 1 retry, 2 physical Tool calls: within 30 s → passed; 20 s → failed", async () => {
    const budget = loadFixture("metrics-budget");
    expect((await grade(metrics({ maxRunDurationMs: 30000, maxRetries: 1, maxPhysicalToolCalls: 2, maxLogicalToolExecutions: 1 }), budget)).status).toBe("passed");
    expect(verdict(await grade(metrics({ maxRunDurationMs: 20000, maxRetries: 1, maxPhysicalToolCalls: 2 }), budget))).toEqual({ status: "failed", failed: ["metrics.run-duration:METRIC_THRESHOLD_EXCEEDED"] });
  });

  it("cost unavailable or partial, partial trace quality, missing or invalid Metrics → error", async () => {
    const unpriced = loadFixture("metrics-cost-unavailable");
    expect(verdict(await grade(metrics({ maxEstimatedCostNanos: 1 }), unpriced))).toMatchObject({ status: "error", errorCode: "EVAL_REQUIRED_EVIDENCE_INCOMPLETE" });
    expect((await grade(metrics({ maxTotalTokens: 1000 }), unpriced)).status).toBe("passed");
    const partial = deriveRunMetrics({ trace: unpriced.trace!, traceHealth: { status: "degraded" } });
    expect(verdict(await grade(metrics({ maxRetries: 5 }), { ...unpriced, metrics: partial.ok ? partial.metrics : undefined }))).toMatchObject({ status: "error", errorCode: "EVAL_REQUIRED_EVIDENCE_INCOMPLETE" });
    expect(verdict(await grade(metrics({ maxRetries: 5 }), { ...unpriced, metrics: undefined }))).toMatchObject({ status: "error", errorCode: "EVAL_EVIDENCE_MISSING" });
    expect(verdict(await grade(metrics({ maxRetries: 5 }), { ...unpriced, metrics: { runId: "run.eval.unpriced", durationMs: 1 } }))).toMatchObject({ status: "error", errorCode: "EVAL_EVIDENCE_INVALID" });
    const waiting = pending();
    expect(verdict(await grade(metrics({ maxRunDurationMs: 1 }), waiting))).toMatchObject({ status: "error", errorCode: "EVAL_REQUIRED_EVIDENCE_INCOMPLETE" });
  });
});
