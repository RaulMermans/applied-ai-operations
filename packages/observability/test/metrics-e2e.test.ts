import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { continueApprovedWorkflow } from "@aao/approval";
import { RunMetricsSchema, auditStreamIdForRun, type AuditEvent, type ModelPricingProfile, type TraceEvent } from "@aao/contracts";
import { createModelNodeExecutor, createModelPolicyRegistry, createModelRegistry, type ModelAdapterResult } from "@aao/model-runtime";
import { createNodeRegistry, executeWorkflow, finalOutputExecutor } from "@aao/runtime";
import { computeAuditEventHash, createAuditRecorder, createInMemoryAuditStore, createInMemoryTraceStore, createTraceRecorder, deriveRunMetrics, validateAuditStream, type DeriveRunMetricsParams, type TraceStore } from "../src/index.js";
import { SECRET, TRANSIENT, bob, clockAt, compile, toolYaml, world } from "./fixtures.js";

const traceFixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/traces/${name}.json`, import.meta.url), "utf8")) as TraceEvent[];

describe("primary Metrics E2E: prepare → approval → retry-safe Tool (fail, retry, succeed) → final", () => {
  it("derives exact Run Metrics from the real Runtime's Trace", async () => {
    const w = world({ toolScript: [TRANSIENT], toolRetrySafety: "safe", reliability: { policiesByNodeId: { lookup: { maxAttempts: 3 } } } });
    const runId = "run.metrics.primary";
    const waiting = await executeWorkflow({ runId, plan: w.plan, registry: w.registry, initialState: { runId, revision: 0, values: {} }, options: w.runtimeOptions });
    w.approvals.approve(waiting.execution!.wait!.referenceId, bob);
    const done = await continueApprovedWorkflow(w.approvals, { plan: w.plan, registry: w.registry, execution: waiting.execution!, options: w.runtimeOptions });
    expect(done.ok && done.execution.run.status).toBe("COMPLETED");
    const trace = await w.store.getRunTrace(runId);
    const projection = deriveRunMetrics({ trace, traceHealth: w.recorder.runHealth(runId) });
    expect(projection.ok && projection.quality).toBe("complete");
    const metrics = projection.ok ? projection.metrics : undefined!;

    // The trace clock ticks one second per event: 24 events, run.started at 0 s, run.completed at 23 s.
    expect(metrics).toMatchObject({
      runStatus: "COMPLETED",
      traceQuality: { status: "complete", issues: [] },
      durationMs: 23_000,
      approvalWaitDurationMs: 1_000,
      durationExcludingApprovalWaitMs: 22_000,
      steps: 4,
      retries: { scheduled: 1, exhausted: 0, nodesRetried: 1 },
      tools: { physicalInvocations: 2, logicalExecutions: 1, completed: 1, failed: 1, blocked: 0 },
      approvals: { requested: 1, approved: 1, rejected: 0, pending: 0 },
      state: { updates: 2, finalStateRevision: 2 },
      models: { callsStarted: 0, callsCompleted: 0, callsFailed: 0, byModel: [] },
      tokenUsage: { status: "complete", inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      cost: { status: "complete", estimatedCostNanos: 0, pricedCalls: 0, unpricedCalls: 0 },
      failures: { failedAttempts: 1, byCategory: [{ category: "TRANSIENT_DEPENDENCY", count: 1 }], byCode: [{ code: "TOOL_EXECUTION_FAILED", count: 1 }], runFailure: null },
    });
    expect(metrics.nodes).toMatchObject({ executions: 4, attempts: 5, recoveryReplayAttempts: 0, completed: 4, failed: 0, waiting: 1 });
    expect(metrics.nodes.attemptDetails.map(({ nodeId, attempt, outcome, durationMs, waitDurationMs }) => [nodeId, attempt, outcome, durationMs, waitDurationMs])).toEqual([
      ["prepare", 1, "completed", 2_000, null],
      ["approval", 1, "completed", 2_000, 1_000],
      ["lookup", 1, "retried", 3_000, null],
      ["lookup", 2, "completed", 4_000, null],
      ["final", 1, "completed", 1_000, null],
    ]);
    expect(w.calls).toHaveLength(2);
    expect(JSON.stringify(metrics)).not.toContain(SECRET);
  });
});

/** summarize (model) → classify (model) → final, with registered provider identity. */
const modelYaml = `
schemaVersion: 1
id: metrics.model
version: "1.0.0"
name: Metrics model
entryNodeId: summarize
nodes:
  - id: summarize
    kind: model
    config: { modelPolicyRef: policy.default, requestStateKey: request1, resultStateKey: summary }
  - id: classify
    kind: model
    config: { modelPolicyRef: policy.default, requestStateKey: request2, resultStateKey: label }
  - id: final
    kind: final_output
    config: {}
edges:
  - { sourceNodeId: summarize, targetNodeId: classify }
  - { sourceNodeId: classify, targetNodeId: final }
`;
const localPricing: ModelPricingProfile = { schemaVersion: 1, profileId: "pricing.local", profileVersion: "2026-10", provider: "local", model: "scripted-model", revision: "2026-10", currency: "USD", inputNanosPerMillionTokens: 3_000_000_000, outputNanosPerMillionTokens: 15_000_000_000 };

async function modelRun(responses: ModelAdapterResult[], runId = "run.metrics.model", store: TraceStore = createInMemoryTraceStore()) {
  let index = 0;
  const models = createModelRegistry();
  models.register({ id: "local.fast", priority: 1, capabilities: ["model.text_generation"], adapter: { invoke: async () => responses[index++]! }, identity: { provider: "local", model: "scripted-model", revision: "2026-10" } });
  const policies = createModelPolicyRegistry();
  policies.register({ schemaVersion: 1, id: "policy.default", version: "1.0.0", name: "Default policy" });
  const registry = createNodeRegistry();
  registry.register(createModelNodeExecutor({ models, policies }));
  registry.register(finalOutputExecutor);
  const recorder = createTraceRecorder({ store, clock: clockAt(0) });
  const request = (invocationId: string) => ({ schemaVersion: 1, invocationId, messages: [{ role: "user", content: `Summarize ${SECRET}` }], output: { kind: "text" } });
  const result = await executeWorkflow({ runId, plan: compile(modelYaml), registry, initialState: { runId, revision: 0, values: { request1: request("inv.summary"), request2: request("inv.label") } }, options: { clock: clockAt(0), trace: recorder } });
  expect(result.ok).toBe(true);
  return { trace: await store.getRunTrace(runId), recorder };
}

describe("real Model Runtime: token usage and modelled cost", () => {
  const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens });

  it("prices exactly from explicit pricing; the same trace without pricing keeps tokens and has unavailable cost", async () => {
    const { trace } = await modelRun([{ status: "succeeded", output: "s", finishReason: "stop", usage: usage(1_200, 350) }, { status: "succeeded", output: "l", finishReason: "stop", usage: usage(800, 150) }]);
    const priced = deriveRunMetrics({ trace, pricing: [localPricing] });
    const unpriced = deriveRunMetrics({ trace });
    const p = priced.ok ? priced.metrics : undefined!;
    const u = unpriced.ok ? unpriced.metrics : undefined!;
    expect(p.tokenUsage).toMatchObject({ status: "complete", inputTokens: 2_000, outputTokens: 500, totalTokens: 2_500 });
    // (2000 × 3e9 + 500 × 15e9) / 1e6 = 13,500,000 nano-USD
    expect(p.cost).toMatchObject({ status: "complete", currency: "USD", estimatedCostNanos: 13_500_000, pricedCalls: 2 });
    expect(p.models.byModel).toEqual([{ identity: { provider: "local", model: "scripted-model", revision: "2026-10" }, callsStarted: 2, callsCompleted: 2, callsFailed: 0, callsWithoutUsage: 0, knownInputTokens: 2_000, knownOutputTokens: 500, knownTotalTokens: 2_500, pricedCalls: 2, unpricedCalls: 0, knownEstimatedCostNanos: 13_500_000 }]);
    expect(u.tokenUsage).toEqual(p.tokenUsage);
    expect(u.cost).toMatchObject({ status: "unavailable", estimatedCostNanos: null, unpricedReasons: [{ reason: "PRICING_PROFILE_NOT_FOUND", count: 2 }] });
  });

  it("partial evidence: one call without usage → structurally valid metrics, partial tokens and cost, no zero substitution", async () => {
    const { trace } = await modelRun([{ status: "succeeded", output: "s", finishReason: "stop", usage: usage(1_200, 350) }, { status: "succeeded", output: "l", finishReason: "stop" }]);
    const projection = deriveRunMetrics({ trace, pricing: [localPricing] });
    const metrics = projection.ok ? projection.metrics : undefined!;
    expect(RunMetricsSchema.safeParse(metrics).success).toBe(true);
    expect(metrics.traceQuality.status).toBe("complete");
    expect(metrics.tokenUsage).toMatchObject({ status: "partial", inputTokens: null, outputTokens: null, totalTokens: null, knownInputTokens: 1_200, callsWithoutUsage: 1 });
    expect(metrics.cost).toMatchObject({ status: "partial", estimatedCostNanos: null, knownEstimatedCostNanos: 8_850_000, pricedCalls: 1, unpricedCalls: 1, unpricedReasons: [{ reason: "USAGE_MISSING", count: 1 }] });
    expect(JSON.stringify(metrics)).not.toContain(SECRET);
  });
});

/** A Trace Store that loses one event (as a failing disk would): the recorder reports the Run degraded. */
function droppingStore(type: string): TraceStore {
  const base = createInMemoryTraceStore();
  let dropped = false;
  return { ...base, append: async (event) => { if (!dropped && event.type === type) { dropped = true; throw new Error("disk"); } return base.append(event); } };
}

async function metricsFixture(name: string): Promise<unknown> {
  const derive = (trace: TraceEvent[], extra: Omit<DeriveRunMetricsParams, "trace"> = {}) => {
    const projection = deriveRunMetrics({ trace, ...extra });
    if (!projection.ok) throw new Error(projection.code);
    return projection.metrics;
  };
  switch (name) {
    case "simple_success": return derive(traceFixture("successful_run"));
    case "retry_then_success": return derive(traceFixture("retry_then_success"));
    case "approval_wait": return derive(traceFixture("approval_wait_then_resume"));
    case "approval_rejected": return derive(traceFixture("failed_run"));
    case "durable_recovery": return derive(traceFixture("durable_recovery"));
    case "tool_denied": return derive(traceFixture("authorization_block"));
    case "trace_partial": {
      const store = droppingStore("state.updated");
      const w = world({ plan: compile(toolYaml), store });
      const runId = "run.fixture";
      await executeWorkflow({ runId, plan: w.plan, registry: w.registry, initialState: { runId, revision: 0, values: { proposal: { q: "x" } } }, options: w.runtimeOptions });
      expect(w.recorder.runHealth(runId).status).toBe("degraded");
      return derive(await store.getRunTrace(runId), { traceHealth: w.recorder.runHealth(runId) });
    }
    case "cost_priced":
    case "cost_unpriced": {
      const { trace } = await modelRun([{ status: "succeeded", output: "s", finishReason: "stop", usage: { inputTokens: 1_200, outputTokens: 350, totalTokens: 1_550 } }, { status: "succeeded", output: "l", finishReason: "stop", usage: { inputTokens: 800, outputTokens: 150, totalTokens: 950 } }], "run.fixture");
      return derive(trace, name === "cost_priced" ? { pricing: [localPricing] } : {});
    }
    default: throw new Error(name);
  }
}

describe("canonical Metrics fixtures (for Sprint 17/18)", () => {
  it.each(["simple_success", "retry_then_success", "approval_wait", "approval_rejected", "durable_recovery", "tool_denied", "trace_partial", "cost_priced", "cost_unpriced"])("%s is deterministic, contract-valid, sanitized, and matches its committed fixture", async (name) => {
    const metrics = await metricsFixture(name);
    expect(await metricsFixture(name)).toEqual(metrics);
    expect(RunMetricsSchema.parse(JSON.parse(JSON.stringify(metrics)))).toEqual(metrics);
    expect(JSON.stringify(metrics)).not.toContain(SECRET);
    if (name === "trace_partial") expect(metrics).toMatchObject({ traceQuality: { status: "partial", issues: [{ code: "METRICS_INCOMPLETE_TRACE" }] } });
    await expect(`${JSON.stringify(metrics, null, 2)}\n`).toMatchFileSnapshot(`./fixtures/metrics/${name}.json`);
  });
});

async function auditFixture(name: string): Promise<{ events: AuditEvent[]; verification: unknown }> {
  const auditStore = createInMemoryAuditStore();
  const runId = "run.fixture";
  const stream = auditStreamIdForRun(runId);
  const flagship = async (resolve: (w: ReturnType<typeof world>, approvalId: string) => void) => {
    const w = world({ auditStore });
    const waiting = await executeWorkflow({ runId, plan: w.plan, registry: w.registry, initialState: { runId, revision: 0, values: {} }, options: w.runtimeOptions });
    resolve(w, waiting.execution!.wait!.referenceId);
    if (w.approvals.getApproval(waiting.execution!.wait!.referenceId)!.status !== "pending") await continueApprovedWorkflow(w.approvals, { plan: w.plan, registry: w.registry, execution: waiting.execution!, options: w.runtimeOptions });
    await w.auditRecorder!.flush();
  };
  const tool = async (grants: Array<"read_only">) => {
    const w = world({ plan: compile(toolYaml), auditStore, grants });
    await executeWorkflow({ runId, plan: w.plan, registry: w.registry, initialState: { runId, revision: 0, values: { proposal: { q: SECRET } } }, options: w.runtimeOptions });
    await w.auditRecorder!.flush();
  };
  switch (name) {
    case "approval_approved": await flagship((w, id) => w.approvals.approve(id, bob)); break;
    case "approval_denied_attempt": await flagship((w, id) => { try { w.approvals.approve(id, { id: "user.alice", type: "user" }); } catch { /* refused */ } }); break;
    case "tool_access_allowed": await tool(["read_only"]); break;
    case "tool_access_denied": await tool([]); break;
    case "cancellation_requested_applied": {
      const recorder = createAuditRecorder({ store: auditStore, clock: clockAt(500) });
      const actor = { id: "user.alice", type: "user" } as const;
      recorder.emit({ type: "run.cancellation.requested", runId, actor, target: { kind: "run", runId }, occurredAt: "2026-10-08T12:00:10.000Z", key: { runId }, payload: { reasonCode: "OPERATOR_REQUEST" } });
      recorder.emit({ type: "run.cancellation.applied", runId, actor, target: { kind: "run", runId }, occurredAt: "2026-10-08T12:00:12.000Z", key: { runId }, payload: { step: 1, nodeId: "approval", requestedAt: "2026-10-08T12:00:10.000Z" } });
      await recorder.flush();
      break;
    }
    case "tampered_chain": {
      const { events } = await auditFixture("approval_approved");
      const tampered = events.map((event) => (event.sequence === 1 ? { ...event, actor: { id: "user.mallory", type: "user" as const } } : event));
      return { events: tampered, verification: validateAuditStream(tampered) };
    }
    default: throw new Error(name);
  }
  const events = await auditStore.getStream(stream);
  return { events, verification: await auditStore.verifyStream(stream) };
}

describe("canonical Audit fixtures", () => {
  it.each(["approval_approved", "approval_denied_attempt", "tool_access_allowed", "tool_access_denied", "cancellation_requested_applied", "tampered_chain"])("%s is deterministic, sanitized, and matches its committed fixture", async (name) => {
    const fixture = await auditFixture(name);
    expect(await auditFixture(name)).toEqual(fixture);
    expect(JSON.stringify(fixture)).not.toContain(SECRET);
    if (name === "tampered_chain") expect(fixture.verification).toEqual({ valid: false, issues: [{ code: "AUDIT_HASH_MISMATCH", index: 1 }] });
    else {
      expect(fixture.verification).toEqual({ valid: true, issues: [] });
      for (const event of fixture.events) expect(computeAuditEventHash(event)).toBe(event.eventHash);
    }
    await expect(`${JSON.stringify(fixture, null, 2)}\n`).toMatchFileSnapshot(`./fixtures/audit/${name}.json`);
  });
});
