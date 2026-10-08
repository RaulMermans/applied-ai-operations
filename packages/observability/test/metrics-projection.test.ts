import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RunMetricsSchema, type ModelPricingProfile, type RunMetrics, type TraceEvent } from "@aao/contracts";
import { createInMemoryTraceStore, createTraceRecorder, deriveRunMetrics, type RunMetricsProjection } from "../src/index.js";
import { ID, at, d, examplePricing, traceOf } from "./metrics-fixtures.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/traces/${name}.json`, import.meta.url), "utf8")) as TraceEvent[];

function metricsOf(projection: RunMetricsProjection): RunMetrics {
  if (!projection.ok) throw new Error(`projection refused: ${projection.code}`);
  return projection.metrics;
}

const TOOL = "tool.exec.1";

describe("Run latency comes from lifecycle events, never checkpoints", () => {
  it("run.started T0 → checkpoint.created T1 → run.completed T2 gives T2 − T0", async () => {
    const trace = await traceOf([[0, d.runStarted()], [59, d.checkpoint(0)], [60, d.runCompleted(0)]]);
    const metrics = metricsOf(deriveRunMetrics({ trace }));
    expect(metrics.durationMs).toBe(60_000);
    expect(metrics.durationMs).not.toBe(1_000);
    expect(metrics.startedAt).toBe(at(0));
    expect(metrics.endedAt).toBe(at(60));
    expect(metrics.durability.checkpointsCreated).toBe(1);
  });

  it("a checkpoint persisted before the boundary's lifecycle events (durable ordering) does not shift duration", () => {
    const trace = fixture("durable_recovery");
    // In this durable trace the final checkpoint (seq 27) precedes node.completed (28) and run.completed (29).
    expect(trace.map((event) => event.type).slice(27)).toEqual(["checkpoint.created", "node.completed", "run.completed"]);
    const metrics = metricsOf(deriveRunMetrics({ trace }));
    expect(metrics.durationMs).toBe(Date.parse(trace.at(-1)!.occurredAt) - Date.parse(trace[0]!.occurredAt));
    expect(metrics.durationMs).toBe(210_000);
  });

  it("without a terminal event, duration is unavailable (null), never zero", async () => {
    const trace = await traceOf([[0, d.runStarted()], [1, d.nodeStarted("a", 1)], [2, d.checkpoint(0)]]);
    const metrics = metricsOf(deriveRunMetrics({ trace }));
    expect(metrics.runStatus).toBe("RUNNING");
    expect(metrics.durationMs).toBeNull();
    expect(metrics.endedAt).toBeNull();
    expect(metrics.steps).toBeNull();
    expect(metrics.nodes.attemptDetails).toEqual([{ nodeId: "a", kind: "deterministic", step: 1, attempt: 1, recoveryReplay: false, outcome: "open", startedAt: at(1), durationMs: null, waitDurationMs: null }]);
  });
});

describe("Node attempts and retries", () => {
  const retryTrace = () => traceOf([
    [0, d.runStarted("lookup", [{ nodeId: "lookup", maxAttempts: 3 }])],
    [1, d.nodeStarted("lookup", 1, 1, "tool")],
    [2, d.toolStarted("lookup", 1, 1, TOOL)],
    [3, d.toolFailed("lookup", 1, 1, TOOL)],
    [5, d.retryScheduled("lookup", 1, 1)],
    [6, d.nodeStarted("lookup", 1, 2, "tool")],
    [7, d.toolStarted("lookup", 1, 2, TOOL)],
    [9, d.toolCompleted("lookup", 1, 2, TOOL)],
    [10, d.nodeCompleted("lookup", 1, 2, "tool")],
    [11, d.runCompleted(1)],
  ]);

  it("pairs each attempt with its own end marker and never merges attempts", async () => {
    const metrics = metricsOf(deriveRunMetrics({ trace: await retryTrace() }));
    expect(metrics.nodes.attemptDetails.map(({ attempt, outcome, durationMs }) => ({ attempt, outcome, durationMs }))).toEqual([
      { attempt: 1, outcome: "retried", durationMs: 4_000 },
      { attempt: 2, outcome: "completed", durationMs: 4_000 },
    ]);
    expect(metrics.nodes.byNode).toEqual([{ nodeId: "lookup", kind: "tool", executions: 1, attempts: 2, completed: 1, failed: 0, waits: 0, attemptDurationMsTotal: 8_000 }]);
    expect(metrics.nodes).toMatchObject({ executions: 1, attempts: 2, recoveryReplayAttempts: 0, completed: 1, failed: 0, waiting: 0 });
  });

  it("derives retries from explicit retry evidence and failures from the existing taxonomy", async () => {
    const metrics = metricsOf(deriveRunMetrics({ trace: await retryTrace() }));
    expect(metrics.retries).toEqual({ scheduled: 1, exhausted: 0, nodesRetried: 1 });
    expect(metrics.failures).toEqual({ failedAttempts: 1, uncategorizedAttempts: 0, byCategory: [{ category: "TRANSIENT_DEPENDENCY", count: 1 }], byCode: [{ code: "TOOL_EXECUTION_FAILED", count: 1 }], detectedEvents: 0, runFailure: null });
    expect(metrics.tools).toEqual({ physicalInvocations: 2, logicalExecutions: 1, completed: 1, failed: 1, blocked: 0, byTool: [{ toolId: "local.lookup", toolVersion: "1.0.0", physicalInvocations: 2, logicalExecutions: 1, completed: 1, failed: 1, blocked: 0 }] });
    expect(metrics.dimensions.reliabilityPolicyFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("retry exhaustion: one exhausted retry budget, two failed attempts, one failed Run", async () => {
    const trace = await traceOf([
      [0, d.runStarted("lookup")],
      [1, d.nodeStarted("lookup", 1, 1, "tool")],
      [2, d.retryScheduled("lookup", 1, 1)],
      [3, d.nodeStarted("lookup", 1, 2, "tool")],
      [4, d.retryExhausted("lookup", 1, 2)],
      [5, d.nodeFailed("lookup", 1, 2, "tool", "NODE_EXECUTION_FAILED", "TRANSIENT_DEPENDENCY", "TOOL_EXECUTION_FAILED")],
      [6, d.runFailed("NODE_EXECUTION_FAILED", "TRANSIENT_DEPENDENCY", 1)],
    ]);
    const metrics = metricsOf(deriveRunMetrics({ trace }));
    expect(metrics.runStatus).toBe("FAILED");
    expect(metrics.retries).toEqual({ scheduled: 1, exhausted: 1, nodesRetried: 1 });
    expect(metrics.failures.failedAttempts).toBe(2);
    expect(metrics.failures.byCode).toEqual([{ code: "TOOL_EXECUTION_FAILED", count: 2 }]);
    expect(metrics.failures.runFailure).toEqual({ code: "NODE_EXECUTION_FAILED", category: "TRANSIENT_DEPENDENCY" });
    expect(metrics.nodes.attemptDetails.map((attempt) => attempt.outcome)).toEqual(["retried", "failed"]);
  });
});

describe("Approval waits are not executor latency", () => {
  const approvalId = "approval:1";
  const prefix: Array<[number, Parameters<typeof traceOf>[0][number][1]]> = [
    [0, d.runStarted("approval")],
    [1, d.nodeStarted("approval", 1, 1, "approval")],
    [2, d.approvalRequested("approval", 1, approvalId)],
    [3, d.nodeWaiting("approval", 1, approvalId)],
  ];

  it("separates execution (start → wait) from approval wait (wait → Runtime consumption of the resolution)", async () => {
    // resolvedAt comes from the Approval Engine's clock; it is not mixed with Trace-clock durations.
    const trace = await traceOf([...prefix, [3_603, d.approvalResolved("approval", approvalId, "approved", at(1_000))], [3_604, d.nodeCompleted("approval", 1, 1, "approval", "approval_resolution")], [3_605, d.runCompleted(1)]]);
    const metrics = metricsOf(deriveRunMetrics({ trace }));
    expect(metrics.nodes.attemptDetails).toEqual([{ nodeId: "approval", kind: "approval", step: 1, attempt: 1, recoveryReplay: false, outcome: "completed", startedAt: at(1), durationMs: 2_000, waitDurationMs: 3_600_000 }]);
    expect(metrics.durationMs).toBe(3_605_000);
    expect(metrics.approvalWaitDurationMs).toBe(3_600_000);
    expect(metrics.durationExcludingApprovalWaitMs).toBe(5_000);
    expect(metrics.approvals).toEqual({ requested: 1, approved: 1, rejected: 0, expired: 0, cancelled: 0, pending: 0 });
  });

  it("a waiting (nonterminal) Run: wait unresolved, so wait and duration are unavailable", async () => {
    const metrics = metricsOf(deriveRunMetrics({ trace: await traceOf(prefix) }));
    expect(metrics.runStatus).toBe("WAITING_FOR_APPROVAL");
    expect(metrics.approvalWaitDurationMs).toBeNull();
    expect(metrics.durationMs).toBeNull();
    expect(metrics.durationExcludingApprovalWaitMs).toBeNull();
    expect(metrics.approvals.pending).toBe(1);
    expect(metrics.nodes.attemptDetails[0]).toMatchObject({ outcome: "waiting", durationMs: 2_000, waitDurationMs: null });
  });

  it("rejection: a failed Run with an APPROVAL failure and a rejected decision", () => {
    const metrics = metricsOf(deriveRunMetrics({ trace: fixture("failed_run") }));
    expect(metrics.runStatus).toBe("FAILED");
    expect(metrics.approvals).toMatchObject({ requested: 1, rejected: 1, approved: 0, pending: 0 });
    expect(metrics.failures).toMatchObject({ failedAttempts: 1, byCategory: [{ category: "APPROVAL", count: 1 }], byCode: [{ code: "APPROVAL_REJECTED", count: 1 }], detectedEvents: 1, runFailure: { code: "APPROVAL_REJECTED", category: "APPROVAL" } });
  });
});

describe("Run outcomes", () => {
  it("cancelled Run", async () => {
    const trace = await traceOf([[0, d.runStarted()], [1, d.nodeStarted("a", 1)], [2, d.nodeCompleted("a", 1)], [4, d.runCancelled(1)]]);
    const metrics = metricsOf(deriveRunMetrics({ trace }));
    expect(metrics.runStatus).toBe("CANCELLED");
    expect(metrics.durationMs).toBe(4_000);
    expect(metrics.failures.runFailure).toBeNull();
  });

  it("Tool authorization block: zero physical invocations, one blocked call, failed Run, existing codes only", () => {
    const metrics = metricsOf(deriveRunMetrics({ trace: fixture("authorization_block") }));
    expect(metrics.tools).toMatchObject({ physicalInvocations: 0, logicalExecutions: 0, blocked: 1, completed: 0, failed: 0 });
    expect(metrics.failures).toMatchObject({ failedAttempts: 1, byCategory: [{ category: "AUTHORIZATION", count: 1 }], byCode: [{ code: "TOOL_AUTHORIZATION_DENIED", count: 1 }], runFailure: { code: "NODE_EXECUTION_FAILED", category: "AUTHORIZATION" } });
  });

  it("durable recovery: durability counts and a recovered attempt (no new Tool call)", () => {
    const metrics = metricsOf(deriveRunMetrics({ trace: fixture("durable_recovery") }));
    expect(metrics.durability).toEqual({ checkpointsCreated: 6, recoveryStarts: 1, recoveryReplays: 0, reusedOutcomes: 1, recoveryBlocks: 0, recoveryCompletions: 1 });
    expect(metrics.tools.physicalInvocations).toBe(1);
    expect(metrics.failures.detectedEvents).toBe(1);
    expect(metrics.state).toEqual({ updates: 2, finalStateRevision: 2 });
  });
});

describe("Model calls and token accounting", () => {
  const identity = { provider: "example", model: "example-model" };
  const twoCalls = (second?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }) => traceOf([
    [0, d.runStarted("m")],
    [1, d.nodeStarted("m", 1, 1, "model")],
    [2, d.modelStarted("m", 1, "inv.1", identity)],
    [3, d.modelCompleted("m", 1, "inv.1", { inputTokens: 1_200, outputTokens: 350, totalTokens: 1_550 })],
    [4, d.modelStarted("m", 1, "inv.2", identity)],
    [5, d.modelCompleted("m", 1, "inv.2", second)],
    [6, d.nodeCompleted("m", 1, 1, "model")],
    [7, d.runCompleted(1)],
  ]);

  it("complete usage: deterministic sums of recorded usage", async () => {
    const metrics = metricsOf(deriveRunMetrics({ trace: await twoCalls({ inputTokens: 800, outputTokens: 150, totalTokens: 950 }) }));
    expect(metrics.tokenUsage).toEqual({ status: "complete", modelCallsCompleted: 2, modelCallsFailed: 0, callsWithUsage: 2, callsWithoutUsage: 0, inputTokens: 2_000, outputTokens: 500, totalTokens: 2_500, knownInputTokens: 2_000, knownOutputTokens: 500, knownTotalTokens: 2_500 });
    expect(metrics.models).toMatchObject({ callsStarted: 2, callsCompleted: 2, callsFailed: 0 });
  });

  it("partial usage: a call without usage is never counted as zero tokens", async () => {
    const metrics = metricsOf(deriveRunMetrics({ trace: await twoCalls(undefined) }));
    expect(metrics.tokenUsage).toEqual({ status: "partial", modelCallsCompleted: 2, modelCallsFailed: 0, callsWithUsage: 1, callsWithoutUsage: 1, inputTokens: null, outputTokens: null, totalTokens: null, knownInputTokens: 1_200, knownOutputTokens: 350, knownTotalTokens: 1_550 });
  });

  it("no usage at all: unavailable; no model calls: complete zero", async () => {
    const none = await traceOf([[0, d.runStarted("m")], [1, d.nodeStarted("m", 1, 1, "model")], [2, d.modelStarted("m", 1, "inv.1", identity)], [3, d.modelCompleted("m", 1, "inv.1")], [4, d.nodeCompleted("m", 1, 1, "model")], [5, d.runCompleted(1)]]);
    expect(metricsOf(deriveRunMetrics({ trace: none })).tokenUsage).toMatchObject({ status: "unavailable", inputTokens: null, outputTokens: null, totalTokens: null, callsWithoutUsage: 1 });
    expect(metricsOf(deriveRunMetrics({ trace: fixture("successful_run") })).tokenUsage).toMatchObject({ status: "complete", inputTokens: 0, outputTokens: 0, totalTokens: 0, modelCallsCompleted: 0 });
  });

  it("a failed model call reports no usage, so accounting is partial", async () => {
    const trace = await traceOf([[0, d.runStarted("m")], [1, d.nodeStarted("m", 1, 1, "model")], [2, d.modelStarted("m", 1, "inv.1", identity)], [3, d.modelCompleted("m", 1, "inv.1", { inputTokens: 10, outputTokens: 5, totalTokens: 15 })], [4, d.modelStarted("m", 1, "inv.2", identity)], [5, d.modelFailed("m", 1, "inv.2")], [6, d.runFailed("NODE_EXECUTION_FAILED", "EXECUTION", 1)]]);
    const metrics = metricsOf(deriveRunMetrics({ trace, pricing: [examplePricing] }));
    expect(metrics.tokenUsage).toMatchObject({ status: "partial", modelCallsFailed: 1, inputTokens: null, knownInputTokens: 10 });
    expect(metrics.cost).toMatchObject({ status: "partial", pricedCalls: 1, unpricedCalls: 1, unpricedReasons: [{ reason: "CALL_FAILED", count: 1 }], estimatedCostNanos: null });
  });

  it("never infers identity from a binding id: calls without registered identity stay in the unregistered bucket", async () => {
    const trace = await traceOf([[0, d.runStarted("m")], [1, d.nodeStarted("m", 1, 1, "model")], [2, d.modelStarted("m", 1, "inv.1")], [3, d.modelCompleted("m", 1, "inv.1", { inputTokens: 1, outputTokens: 1, totalTokens: 2 })], [4, d.nodeCompleted("m", 1, 1, "model")], [5, d.runCompleted(1)]]);
    const metrics = metricsOf(deriveRunMetrics({ trace, pricing: [examplePricing] }));
    expect(metrics.models.byModel).toEqual([{ identity: null, callsStarted: 1, callsCompleted: 1, callsFailed: 0, callsWithoutUsage: 0, knownInputTokens: 1, knownOutputTokens: 1, knownTotalTokens: 2, pricedCalls: 0, unpricedCalls: 1, knownEstimatedCostNanos: 0 }]);
    expect(metrics.cost).toMatchObject({ status: "unavailable", estimatedCostNanos: null, unpricedReasons: [{ reason: "MODEL_IDENTITY_MISSING", count: 1 }] });
  });
});

describe("cost accounting requires explicit pricing", () => {
  const oneCall = (identity: { provider: string; model: string; revision?: string } = { provider: "example", model: "example-model" }, usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = { inputTokens: 1_200, outputTokens: 350, totalTokens: 1_550 }) =>
    traceOf([[0, d.runStarted("m")], [1, d.nodeStarted("m", 1, 1, "model")], [2, d.modelStarted("m", 1, "inv.1", identity)], [3, d.modelCompleted("m", 1, "inv.1", usage)], [4, d.nodeCompleted("m", 1, 1, "model")], [5, d.runCompleted(1)]]);

  it("prices exactly from an explicit profile in integer nano-units", async () => {
    const metrics = metricsOf(deriveRunMetrics({ trace: await oneCall(), pricing: [examplePricing] }));
    // (1200 × 3e9 + 350 × 15e9) / 1e6 = 8,850,000 nano-USD ($0.00885)
    expect(metrics.cost).toEqual({ status: "complete", currency: "USD", estimatedCostNanos: 8_850_000, knownEstimatedCostNanos: 8_850_000, pricedCalls: 1, unpricedCalls: 0, unpricedReasons: [], pricingProfiles: [{ profileId: "pricing.example", profileVersion: "2026-01" }] });
  });

  it("without a matching profile: token usage unchanged, cost unavailable — never zero", async () => {
    const trace = await oneCall();
    const priced = metricsOf(deriveRunMetrics({ trace, pricing: [examplePricing] }));
    const unpriced = metricsOf(deriveRunMetrics({ trace }));
    expect(unpriced.tokenUsage).toEqual(priced.tokenUsage);
    expect(unpriced.cost).toEqual({ status: "unavailable", currency: null, estimatedCostNanos: null, knownEstimatedCostNanos: 0, pricedCalls: 0, unpricedCalls: 1, unpricedReasons: [{ reason: "PRICING_PROFILE_NOT_FOUND", count: 1 }], pricingProfiles: [] });
  });

  it("partial coverage: one priced call and one unpriced call is partial, never presented as total", async () => {
    const trace = await traceOf([
      [0, d.runStarted("m")], [1, d.nodeStarted("m", 1, 1, "model")],
      [2, d.modelStarted("m", 1, "inv.1", { provider: "example", model: "example-model" })], [3, d.modelCompleted("m", 1, "inv.1", { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 })],
      [4, d.modelStarted("m", 1, "inv.2", { provider: "other", model: "other-model" })], [5, d.modelCompleted("m", 1, "inv.2", { inputTokens: 5, outputTokens: 5, totalTokens: 10 })],
      [6, d.nodeCompleted("m", 1, 1, "model")], [7, d.runCompleted(1)],
    ]);
    const metrics = metricsOf(deriveRunMetrics({ trace, pricing: [examplePricing] }));
    expect(metrics.cost).toMatchObject({ status: "partial", estimatedCostNanos: null, knownEstimatedCostNanos: 3_000_000_000, pricedCalls: 1, unpricedCalls: 1 });
    expect(metrics.models.byModel.map((entry) => [entry.identity?.provider, entry.pricedCalls, entry.unpricedCalls, entry.knownEstimatedCostNanos])).toEqual([["example", 1, 0, 3_000_000_000], ["other", 0, 1, 0]]);
  });

  it("matches only exact provider + model (+ revision when the profile names one); no substring matching", async () => {
    const revisioned: ModelPricingProfile = { ...examplePricing, profileId: "pricing.example.r1", revision: "r1" };
    expect(metricsOf(deriveRunMetrics({ trace: await oneCall({ provider: "example", model: "example-model-pro" }), pricing: [examplePricing] })).cost.status).toBe("unavailable");
    expect(metricsOf(deriveRunMetrics({ trace: await oneCall({ provider: "example", model: "example-model", revision: "r2" }), pricing: [revisioned] })).cost.status).toBe("unavailable");
    expect(metricsOf(deriveRunMetrics({ trace: await oneCall({ provider: "example", model: "example-model" }), pricing: [revisioned] })).cost.status).toBe("unavailable");
    expect(metricsOf(deriveRunMetrics({ trace: await oneCall({ provider: "example", model: "example-model", revision: "r1" }), pricing: [revisioned] })).cost.status).toBe("complete");
    // A revision-free profile prices any revision of the exact model; an exact revision profile wins over it.
    const cheaper: ModelPricingProfile = { ...revisioned, inputNanosPerMillionTokens: 0, outputNanosPerMillionTokens: 0 };
    expect(metricsOf(deriveRunMetrics({ trace: await oneCall({ provider: "example", model: "example-model", revision: "r9" }), pricing: [examplePricing, cheaper] })).cost.estimatedCostNanos).toBe(8_850_000);
    expect(metricsOf(deriveRunMetrics({ trace: await oneCall({ provider: "example", model: "example-model", revision: "r1" }), pricing: [examplePricing, cheaper] })).cost.estimatedCostNanos).toBe(0);
  });

  it("rounds each priced call half-up to a whole nano-unit, deterministically", async () => {
    const perToken: ModelPricingProfile = { ...examplePricing, inputNanosPerMillionTokens: 1, outputNanosPerMillionTokens: 0 };
    const cost = async (inputTokens: number) => metricsOf(deriveRunMetrics({ trace: await oneCall(undefined, { inputTokens, outputTokens: 0, totalTokens: inputTokens }), pricing: [perToken] })).cost.estimatedCostNanos;
    expect(await cost(499_999)).toBe(0);
    expect(await cost(500_000)).toBe(1);
    expect(await cost(1_500_000)).toBe(2);
  });

  it("missing usage leaves a matched call unpriced", async () => {
    const metrics = metricsOf(deriveRunMetrics({ trace: await oneCall(undefined, { totalTokens: 10 }), pricing: [examplePricing] }));
    expect(metrics.cost).toMatchObject({ status: "unavailable", unpricedReasons: [{ reason: "USAGE_MISSING", count: 1 }] });
    expect(metrics.tokenUsage).toMatchObject({ status: "partial", totalTokens: 10, inputTokens: null });
  });

  it.each([
    ["duplicate identity", [examplePricing, { ...examplePricing, profileId: "pricing.dup" }]],
    ["mixed currencies", [examplePricing, { ...examplePricing, model: "other", currency: "EUR" }]],
    ["floating-point price", [{ ...examplePricing, inputNanosPerMillionTokens: 1.5 }]],
    ["unexpected field", [{ ...examplePricing, url: "https://pricing.example" }]],
  ])("rejects an untrusted or ambiguous pricing set: %s", async (_name, pricing) => {
    expect(deriveRunMetrics({ trace: await oneCall(), pricing: pricing as ModelPricingProfile[] })).toEqual({ ok: false, quality: "invalid", code: "METRICS_INVALID_PRICING_PROFILE" });
  });
});

describe("evidence quality", () => {
  it("refuses an invalid trace with a stable diagnostic instead of normal-looking metrics", () => {
    const trace = fixture("retry_then_success");
    const reordered = [trace[0]!, trace[13]!, ...trace.slice(1, 13)];
    const projection = deriveRunMetrics({ trace: reordered });
    expect(projection).toMatchObject({ ok: false, quality: "invalid", code: "METRICS_INVALID_TRACE" });
    expect(projection.ok === false && projection.code === "METRICS_INVALID_TRACE" && projection.traceIssues.map((issue) => issue.code)).toContain("TRACE_SEQUENCE_GAP");
    expect(deriveRunMetrics({ trace: [] })).toMatchObject({ ok: false, code: "METRICS_INVALID_TRACE", traceIssues: [{ code: "TRACE_RUN_START_MISSING" }] });
    const tampered = trace.map((event) => (event.type === "run.completed" ? { ...event, payload: { ...event.payload, steps: "two" } } : event));
    expect(deriveRunMetrics({ trace: tampered })).toMatchObject({ ok: false, code: "METRICS_INVALID_TRACE" });
  });

  it("surfaces a degraded recorder report as partial trace quality, reusing the recorder's own completeness", () => {
    const trace = fixture("successful_run");
    expect(deriveRunMetrics({ trace, traceHealth: { status: "healthy" } })).toMatchObject({ ok: true, quality: "complete", metrics: { traceQuality: { status: "complete", issues: [] } } });
    expect(deriveRunMetrics({ trace, traceHealth: { status: "degraded" } })).toMatchObject({ ok: true, quality: "partial", metrics: { traceQuality: { status: "partial", issues: [{ code: "METRICS_INCOMPLETE_TRACE" }] } } });
  });

  it("is deterministic and JSON-safe: same Trace + same pricing → deep-equal RunMetrics", () => {
    for (const name of ["successful_run", "retry_then_success", "approval_wait_then_resume", "authorization_block", "durable_recovery", "failed_run"]) {
      const first = deriveRunMetrics({ trace: fixture(name), pricing: [examplePricing] });
      expect(deriveRunMetrics({ trace: fixture(name), pricing: [examplePricing] })).toEqual(first);
      const metrics = metricsOf(first);
      expect(RunMetricsSchema.parse(JSON.parse(JSON.stringify(metrics)))).toEqual(metrics);
    }
  });

  it("surfaces optional release dimensions only when the trace carries them", async () => {
    const store = createInMemoryTraceStore();
    const recorder = createTraceRecorder({ store, clock: { now: () => at(0) }, release: { releaseId: "release.2026-10", gitSha: "25b90b7", environment: "local" } });
    await recorder.emit({ ...ID, ...d.runStarted() } as never);
    await recorder.emit({ ...ID, ...d.runCompleted(0) } as never);
    const metrics = metricsOf(deriveRunMetrics({ trace: await store.getRunTrace(ID.runId) }));
    expect(metrics.dimensions).toEqual({ reliabilityPolicyFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), releaseId: "release.2026-10", gitSha: "25b90b7", environment: "local" });
    expect(metricsOf(deriveRunMetrics({ trace: fixture("successful_run") })).dimensions).not.toHaveProperty("releaseId");
  });

  it("agent executions and iterations come only from Agent events (no semantic quality)", async () => {
    const agentRef = { id: "agent.researcher", version: "1.0.0" };
    const span = { kind: "agent" as const, agentExecutionId: "agent.exec.1", attempt: 1 };
    const parentSpan = { kind: "node" as const, nodeId: "research", step: 1, attempt: 1 };
    const trace = await traceOf([
      [0, d.runStarted("research")],
      [1, d.nodeStarted("research", 1, 1, "deterministic")],
      [2, { type: "agent.started", nodeId: "research", span, parentSpan, key: { step: 1 }, payload: { agentRef, agentExecutionId: "agent.exec.1", attempt: 1, modelPolicyRef: "policy.default", maxIterations: 4 } }],
      [3, { type: "agent.iteration.completed", nodeId: "research", span, parentSpan, key: { iteration: 1 }, payload: { agentRef, agentExecutionId: "agent.exec.1", attempt: 1, iteration: 1, action: "CONTINUE", invocationId: "inv.1", modelBindingId: "binding.default" } }],
      [4, { type: "agent.iteration.completed", nodeId: "research", span, parentSpan, key: { iteration: 2 }, payload: { agentRef, agentExecutionId: "agent.exec.1", attempt: 1, iteration: 2, action: "COMPLETE", invocationId: "inv.2", modelBindingId: "binding.default" } }],
      [5, { type: "agent.completed", nodeId: "research", span, parentSpan, key: {}, payload: { agentRef, agentExecutionId: "agent.exec.1", attempt: 1, iterationsUsed: 2 } }],
      [6, d.nodeCompleted("research", 1)],
      [7, d.runCompleted(1)],
    ]);
    expect(metricsOf(deriveRunMetrics({ trace })).agents).toEqual({ executions: 1, iterations: 2, completed: 1, failed: 0 });
  });
});
