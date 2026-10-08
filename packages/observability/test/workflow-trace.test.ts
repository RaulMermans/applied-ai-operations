import { describe, expect, it } from "vitest";
import { continueApprovedWorkflow } from "@aao/approval";
import { TraceEventSchema, type TraceEvent } from "@aao/contracts";
import { executeWorkflow, type RuntimeSleeper, type WorkflowExecutionResult } from "@aao/runtime";
import type { ToolHandlerResult } from "@aao/tool-runtime";
import { compareTraceWithExecution, createInMemoryTraceStore, findForbiddenTraceKeys, validateTrace, type TraceStore } from "../src/index.js";
import { SECRET, TRANSIENT, bob, compile, ofType, toolYaml, trajectory, world, type WorldOptions } from "./fixtures.js";

const runId = "run.trace.flagship";
const retrying: WorldOptions = { toolScript: [TRANSIENT], toolRetrySafety: "safe", reliability: { policiesByNodeId: { lookup: { maxAttempts: 3 } } } };

/** prepare → approval wait → human approval → resume (→ Tool → final). */
async function runFlagship(options: WorldOptions = retrying, resolution: "approve" | "reject" = "approve") {
  const w = world(options);
  const waiting = await executeWorkflow({ runId, plan: w.plan, registry: w.registry, initialState: { runId, revision: 0, values: {} }, options: w.runtimeOptions });
  if (!waiting.ok) throw new Error("did not reach the approval wait");
  const approvalId = waiting.execution.wait!.referenceId;
  if (resolution === "approve") w.approvals.approve(approvalId, bob);
  else w.approvals.reject(approvalId, bob);
  const result = await continueApprovedWorkflow(w.approvals, { plan: w.plan, registry: w.registry, execution: waiting.execution, options: w.runtimeOptions });
  return { ...w, waiting, result, approvalId, events: await w.store.getRunTrace(runId) };
}

describe("full governed workflow trace: approval → retry → Tool success → completion", () => {
  it("reconstructs the meaningful trajectory in sequence order", async () => {
    const { events, result, calls, recorder } = await runFlagship();
    expect(result.ok && result.execution.run.status).toBe("COMPLETED");
    expect(calls).toHaveLength(2);
    expect(trajectory(events)).toEqual([
      "run.started",
      "node.started@prepare",
      "state.updated@prepare",
      "node.completed@prepare",
      "route.selected",
      "node.started@approval",
      "approval.requested@approval",
      "node.waiting@approval",
      "approval.resolved@approval",
      "node.completed@approval",
      "route.selected",
      "node.started@lookup",
      "tool.call.started@lookup",
      "tool.call.failed@lookup",
      "retry.scheduled@lookup",
      "node.started@lookup",
      "tool.call.started@lookup",
      "tool.call.completed@lookup",
      "state.updated@lookup",
      "node.completed@lookup",
      "route.selected",
      "node.started@final",
      "node.completed@final",
      "run.completed",
    ]);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index));
    expect(new Set(events.map((event) => event.traceId)).size).toBe(1);
    expect(recorder.health()).toMatchObject({ status: "healthy", issueCount: 0, appended: events.length });
  });

  it("carries the semantic facts of each step, not just event names", async () => {
    const { events, approvalId } = await runFlagship();
    const [started] = ofType(events, "run.started");
    expect(started!.payload).toMatchObject({ entryNodeId: "prepare", initialStateRevision: 0, nodeCount: 4, reliabilityPolicies: [{ nodeId: "lookup", maxAttempts: 3 }] });
    expect(started!.payload.reliabilityPolicyFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(ofType(events, "route.selected").map((event) => [event.payload.sourceNodeId, event.payload.targetNodeId])).toEqual([["prepare", "approval"], ["approval", "lookup"], ["lookup", "final"]]);
    expect(ofType(events, "state.updated").map((event) => event.payload)).toEqual([
      { step: 1, revisionBefore: 0, revisionAfter: 1, changedKeys: ["proposal"] },
      { step: 3, revisionBefore: 1, revisionAfter: 2, changedKeys: ["lookupResult"] },
    ]);
    expect(ofType(events, "approval.requested")[0]!.payload).toMatchObject({ approvalId, requestedBy: { id: "user.alice", type: "user" }, requiredApproverRoleIds: ["manager"], permissionClasses: ["read_only"], allowSelfApproval: false });
    expect(ofType(events, "approval.resolved")[0]!.payload).toMatchObject({ approvalId, status: "approved", resolvedBy: { id: "user.bob", type: "user" } });
    expect(ofType(events, "node.waiting")[0]!.payload).toMatchObject({ waitKind: "approval", referenceId: approvalId });
    expect(ofType(events, "node.started").filter((event) => event.nodeId === "lookup").map((event) => event.payload.attempt)).toEqual([1, 2]);
    expect(ofType(events, "tool.call.started").map((event) => event.payload)).toEqual([1, 2].map((attempt) => expect.objectContaining({ attempt, toolRef: { id: "local.lookup", version: "1.0.0" }, permissionClasses: ["read_only"], access: { decision: "allow", principalId: "user.alice", agentCeilingApplied: false }, recoveryReplay: false })));
    expect(ofType(events, "tool.call.failed")[0]!.payload).toMatchObject({ attempt: 1, code: "TOOL_EXECUTION_FAILED", handlerFailureCode: "UPSTREAM_UNAVAILABLE", retryable: true, category: "TRANSIENT_DEPENDENCY" });
    expect(ofType(events, "retry.scheduled")[0]!.payload).toEqual({ step: 3, failedAttempt: 1, nextAttempt: 2, maxAttempts: 3, category: "TRANSIENT_DEPENDENCY", causeCode: "TOOL_EXECUTION_FAILED", delayMs: 0 });
    expect(ofType(events, "tool.call.completed")[0]!.payload).toMatchObject({ attempt: 2, result: "success" });
    expect(ofType(events, "node.completed").find((event) => event.nodeId === "lookup")!.payload).toMatchObject({ attemptCount: 2, outcomeSource: "executor" });
    expect(ofType(events, "node.completed").find((event) => event.nodeId === "approval")!.payload).toMatchObject({ outcomeSource: "approval_resolution" });
    expect(ofType(events, "run.completed")[0]!.payload).toEqual({ finalNodeId: "final", stateRevision: 2, steps: 4 });
  });

  it("nests spans Run → Node attempt → Tool call, each Tool attempt in its own span", async () => {
    const { events } = await runFlagship();
    const runSpan = ofType(events, "run.started")[0]!.spanId;
    const nodeStarts = ofType(events, "node.started");
    for (const node of nodeStarts) expect(node.parentSpanId).toBe(runSpan);
    const toolStarts = ofType(events, "tool.call.started");
    const lookupSpans = nodeStarts.filter((event) => event.nodeId === "lookup").map((event) => event.spanId);
    expect(toolStarts.map((event) => event.parentSpanId)).toEqual(lookupSpans);
    expect(new Set(toolStarts.map((event) => event.spanId)).size).toBe(2);
    expect(ofType(events, "tool.call.completed")[0]!.spanId).toBe(toolStarts[1]!.spanId);
  });

  it("is valid against the Trace contract and consistent with Runtime execution state", async () => {
    const { events, result } = await runFlagship();
    expect(validateTrace(events, { runStatus: "COMPLETED" })).toEqual({ valid: true, issues: [] });
    expect(compareTraceWithExecution(events, result.execution!)).toEqual({ valid: true, issues: [] });
  });

  it("is deterministic: the same inputs produce the same ids, sequence, types, payloads, and times", async () => {
    const first = (await runFlagship()).events;
    const second = (await runFlagship()).events;
    expect(second).toEqual(first);
  });

  it("every event survives TraceEventSchema → JSON → TraceEventSchema with equality", async () => {
    const { events } = await runFlagship();
    for (const event of events) {
      const parsed = TraceEventSchema.parse(event);
      expect(TraceEventSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    }
  });
});

describe("privacy: metadata-only trace content", () => {
  it("never stores secrets, Tool input/output, state values, approval subject, or forbidden keys", async () => {
    const { events, result } = await runFlagship();
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("account-a");
    expect(serialized).not.toContain("apiKeyEcho");
    expect(serialized).not.toContain("credential");
    expect(JSON.stringify(result.execution!.state)).toContain(SECRET); // the content exists in state; Trace simply never copies it
    for (const event of events) expect(findForbiddenTraceKeys(event.payload)).toEqual([]);
  });
});

describe("approval rejection trace", () => {
  it("shows requested → resolved(rejected) → node.failed → failure.detected → run.failed, and no Tool call", async () => {
    const { events, result, calls } = await runFlagship(retrying, "reject");
    expect(!result.ok && result.failure.code).toBe("APPROVAL_REJECTED");
    expect(calls).toHaveLength(0);
    expect(trajectory(events).slice(-5)).toEqual(["approval.requested@approval", "node.waiting@approval", "approval.resolved@approval", "node.failed@approval", "failure.detected@approval", "run.failed"].slice(-5));
    expect(trajectory(events)).toContain("approval.requested@approval");
    expect(ofType(events, "approval.resolved")[0]!.payload).toMatchObject({ status: "rejected" });
    expect(ofType(events, "node.failed")[0]!.payload).toMatchObject({ code: "APPROVAL_REJECTED", category: "APPROVAL" });
    expect(ofType(events, "run.failed")[0]!.payload).toMatchObject({ code: "APPROVAL_REJECTED" });
    expect(ofType(events, "tool.call.started")).toHaveLength(0);
    expect(compareTraceWithExecution(events, result.execution!).valid).toBe(true);
  });
});

async function runTool(options: WorldOptions & { policy?: { maxAttempts: number; attemptTimeoutMs?: number } } = {}) {
  const w = world({ plan: compile(toolYaml), ...options, ...(options.policy ? { reliability: { policiesByNodeId: { lookup: options.policy } } } : {}) });
  const id = "run.trace.tool";
  const result = await executeWorkflow({ runId: id, plan: w.plan, registry: w.registry, initialState: { runId: id, revision: 0, values: { proposal: { q: "alpha" } } }, options: w.runtimeOptions });
  return { ...w, result, events: await w.store.getRunTrace(id) };
}

describe("Tool authorization denial trace", () => {
  it("records tool.call.blocked with the deny reason — never tool.call.started — and zero handler calls", async () => {
    const { events, result, calls } = await runTool({ grants: [] });
    expect(!result.ok && result.failure.executorFailure?.code).toBe("TOOL_AUTHORIZATION_DENIED");
    expect(calls).toHaveLength(0);
    expect(trajectory(events)).toEqual(["run.started", "node.started@lookup", "tool.call.blocked@lookup", "node.failed@lookup", "failure.detected@lookup", "run.failed"]);
    expect(ofType(events, "tool.call.blocked")[0]!.payload).toMatchObject({ code: "TOOL_AUTHORIZATION_DENIED", category: "AUTHORIZATION", permissionClasses: ["read_only"], access: { decision: "deny", reasonCode: expect.any(String) } });
    expect(ofType(events, "tool.call.started")).toHaveLength(0);
    expect(validateTrace(events, { runStatus: "FAILED" }).valid).toBe(true);
  });

  it("an unsupported permission class fails Runtime preflight: the Node never starts, so no Tool event at all", async () => {
    // The Tool Node rejects unsupported Tools in preflight (before any Node is READY): only the Run failure is traced.
    const { events, calls } = await runTool({ toolPermission: "external_side_effect" });
    expect(calls).toHaveLength(0);
    expect(trajectory(events)).toEqual(["run.started", "failure.detected@lookup", "run.failed"]);
    expect(ofType(events, "failure.detected")[0]!.payload).toMatchObject({ code: "RUNTIME_PREFLIGHT_FAILED" });
  });
});

describe("retry trace", () => {
  it("transient failure then success: exactly two Tool attempts traced, no third", async () => {
    const { events, calls } = await runTool({ toolScript: [TRANSIENT], toolRetrySafety: "safe", policy: { maxAttempts: 3 } });
    expect(calls).toHaveLength(2);
    expect(trajectory(events).filter((label) => /tool|retry|node\.(started|completed)@lookup/.test(label))).toEqual(["node.started@lookup", "tool.call.started@lookup", "tool.call.failed@lookup", "retry.scheduled@lookup", "node.started@lookup", "tool.call.started@lookup", "tool.call.completed@lookup", "node.completed@lookup"]);
    expect(ofType(events, "retry.scheduled")[0]!.payload).toMatchObject({ failedAttempt: 1, nextAttempt: 2 });
  });

  it("exhaustion: retry.exhausted, then node.failed and run.failed as separate lifecycle events", async () => {
    const { events, calls } = await runTool({ toolScript: [TRANSIENT, TRANSIENT, TRANSIENT], toolRetrySafety: "safe", policy: { maxAttempts: 3 } });
    expect(calls).toHaveLength(3);
    expect(ofType(events, "retry.scheduled").map((event) => event.payload.nextAttempt)).toEqual([2, 3]);
    expect(ofType(events, "retry.exhausted")[0]!.payload).toEqual({ step: 1, attempt: 3, maxAttempts: 3, category: "TRANSIENT_DEPENDENCY", causeCode: "TOOL_EXECUTION_FAILED" });
    expect(trajectory(events).slice(-4)).toEqual(["retry.exhausted@lookup", "node.failed@lookup", "failure.detected@lookup", "run.failed"]);
    expect(ofType(events, "node.failed")[0]!.payload).toMatchObject({ code: "NODE_RETRY_EXHAUSTED", attemptCount: 3, causeCode: "TOOL_EXECUTION_FAILED" });
  });

  it("an unsafe Tool's retryable failure is never retried, and the trace shows no retry", async () => {
    const { events, calls } = await runTool({ toolScript: [TRANSIENT], policy: { maxAttempts: 3 } });
    expect(calls).toHaveLength(1);
    expect(ofType(events, "retry.scheduled")).toHaveLength(0);
  });
});

describe("timeout trace and late results", () => {
  it("a timed-out attempt is traced as TIMEOUT; its late completion never becomes trace evidence", async () => {
    let releaseLate!: (value: ToolHandlerResult) => void;
    const late = new Promise<ToolHandlerResult>((resolve) => (releaseLate = resolve));
    let timers = 0;
    // First attempt's timer fires immediately; later timers wait until aborted.
    const sleeper: RuntimeSleeper = { sleep: (_ms, signal) => (signal && timers++ === 0 ? Promise.resolve() : new Promise<void>((resolve) => { if (!signal) return resolve(); signal.addEventListener("abort", () => resolve(), { once: true }); })) };
    const { events: before, calls, store, recorder } = await runTool({ toolScript: [() => late, { ok: true, output: { n: 2 } }], toolRetrySafety: "safe", policy: { maxAttempts: 2, attemptTimeoutMs: 500 }, sleeper });
    expect(calls).toHaveLength(2);
    expect(ofType(before, "retry.scheduled")[0]!.payload).toMatchObject({ category: "TIMEOUT", causeCode: "NODE_ATTEMPT_TIMEOUT", failedAttempt: 1 });
    releaseLate({ ok: true, output: { n: 1 } });
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    const after = await store.getRunTrace("run.trace.tool");
    expect(after).toEqual(before);
    expect(ofType(after, "tool.call.completed").map((event) => event.payload.attempt)).toEqual([2]);
    expect(recorder.health().status).toBe("healthy");
  });
});

/** A store whose writes always fail with an error carrying sensitive text. */
function failingStore(): TraceStore {
  const base = createInMemoryTraceStore();
  return { ...base, append: async () => { throw new Error(`disk full at /secret/path ${SECRET}`); } };
}

/** A store whose writes fail only after the n-th successful write. */
function flakyStore(okWrites: number): TraceStore {
  const base = createInMemoryTraceStore();
  let writes = 0;
  return { ...base, append: async (event) => { writes += 1; if (writes > okWrites) throw new Error("EIO"); return base.append(event); } };
}

function outcomeOf(result: WorkflowExecutionResult) {
  return { ok: result.ok, status: result.execution?.run.status, state: result.execution?.state, history: result.execution?.history, failure: result.ok ? undefined : result.failure };
}

describe("trace failure isolation", () => {
  it("a failing Trace Store changes nothing: same outcome, handler calls, state, and approval behavior; recorder degraded; no raw error", async () => {
    const baseline = await runFlagship({ ...retrying, tracing: false });
    const traced = await runFlagship({ ...retrying, store: failingStore() });
    expect(outcomeOf(traced.result)).toEqual(outcomeOf(baseline.result));
    expect(outcomeOf(traced.waiting)).toEqual(outcomeOf(baseline.waiting));
    expect(traced.calls).toHaveLength(baseline.calls.length);
    expect(traced.approvals.getApproval(traced.approvalId)?.status).toBe("approved");
    const health = traced.recorder.health();
    expect(health.status).toBe("degraded");
    expect(health.appended).toBe(0);
    expect(health.issues.every((issue) => issue.code === "TRACE_STORE_FAILURE")).toBe(true);
    expect(JSON.stringify(health)).not.toContain(SECRET);
    expect(JSON.stringify(health)).not.toContain("/secret/path");
    expect(traced.recorder.runHealth(runId).status).toBe("degraded");
  });

  it("Tool succeeds, then trace append throws: one Tool call, no retry, state commits, trace degraded", async () => {
    // Writes fail from tool.call.completed onwards (run.started, node.started, tool.call.started succeed).
    const { result, calls, recorder, events } = await runTool({ store: flakyStore(3), toolRetrySafety: "safe", policy: { maxAttempts: 3 } });
    expect(calls).toHaveLength(1);
    expect(result.ok && result.execution.run.status).toBe("COMPLETED");
    expect(result.ok && result.execution.state.revision).toBe(1);
    expect(result.ok && result.execution.history[0]!.attemptCount).toBe(1);
    expect(recorder.health().status).toBe("degraded");
    expect(trajectory(events)).toEqual(["run.started", "node.started@lookup", "tool.call.started@lookup"]);
    expect(validateTrace(events, { runStatus: "COMPLETED" }).valid).toBe(false);
  });

  it("a throwing trace port is swallowed by the Runtime", async () => {
    const w = world({ plan: compile(toolYaml), tracing: false });
    const id = "run.trace.port";
    const result = await executeWorkflow({ runId: id, plan: w.plan, registry: w.registry, initialState: { runId: id, revision: 0, values: { proposal: {} } }, options: { ...w.runtimeOptions, trace: { emit: () => { throw new Error("boom"); } } } });
    expect(result.ok).toBe(true);
    expect(w.calls).toHaveLength(1);
  });

  it("a malformed trace port is rejected as invalid input before any Run exists", async () => {
    const w = world({ plan: compile(toolYaml), tracing: false });
    const id = "run.trace.bad";
    const result = await executeWorkflow({ runId: id, plan: w.plan, registry: w.registry, initialState: { runId: id, revision: 0, values: {} }, options: { trace: {} as never } });
    expect(!result.ok && result.failure.code).toBe("INVALID_RUNTIME_INPUT");
  });

  it("execution without a recorder still works (tracing is optional)", async () => {
    const { result, events } = await runTool({ tracing: false });
    expect(result.ok).toBe(true);
    expect(events).toEqual([]);
  });
});

describe("Trace-vs-Runtime comparison detects incompleteness", () => {
  it("reports missing and inconsistent evidence; never repairs", async () => {
    const { events, result } = await runFlagship();
    const execution = result.execution!;
    const dropped = (type: string, nodeId?: string) => events.filter((event) => !(event.type === type && (nodeId === undefined || event.nodeId === nodeId))).map((event, index) => ({ ...event, sequence: index }));
    const codes = (candidate: TraceEvent[]) => compareTraceWithExecution(candidate, execution).issues.map((issue) => issue.code);
    expect(codes(dropped("run.completed"))).toContain("TRACE_TERMINAL_EVENT_MISSING");
    expect(codes(dropped("node.completed", "lookup"))).toContain("TRACE_NODE_EVENT_MISMATCH");
    expect(codes(dropped("state.updated", "lookup"))).toContain("TRACE_STATE_MISMATCH");
    expect(codes(dropped("retry.scheduled"))).toContain("TRACE_RETRY_EVENT_MISMATCH");
    expect(codes(events.slice(0, 10))).toEqual(expect.arrayContaining(["TRACE_TERMINAL_EVENT_MISSING", "TRACE_NODE_EVENT_MISMATCH"]));
    expect(codes(events.filter((event) => event.sequence !== 5))).toContain("TRACE_SEQUENCE_GAP");
  });
});
