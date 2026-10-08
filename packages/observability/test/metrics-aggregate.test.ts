import { describe, expect, it } from "vitest";
import { AggregateMetricsSchema, type RunMetrics } from "@aao/contracts";
import { aggregateRunMetrics, deriveRunMetrics, nearestRankPercentile } from "../src/index.js";
import { d, examplePricing, traceOf } from "./metrics-fixtures.js";

describe("nearest-rank percentiles", () => {
  it("one value is every percentile", () => {
    expect([1, 50, 95, 100].map((p) => nearestRankPercentile([42], p))).toEqual([42, 42, 42, 42]);
  });

  it("two values: p50 is the lower, p95 the upper", () => {
    expect(nearestRankPercentile([200, 100], 50)).toBe(100);
    expect(nearestRankPercentile([200, 100], 95)).toBe(200);
  });

  it("odd and even sample sizes return observed values (no interpolation)", () => {
    expect(nearestRankPercentile([5, 1, 3], 50)).toBe(3);
    expect(nearestRankPercentile([1, 2, 3, 4], 50)).toBe(2);
    expect(nearestRankPercentile([1, 2, 3, 4], 95)).toBe(4);
    const twenty = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(nearestRankPercentile(twenty, 95)).toBe(19);
    expect(nearestRankPercentile(twenty, 100)).toBe(20);
    const sixty = Array.from({ length: 60 }, (_, index) => index + 1);
    // 95 × 60 / 100 = 57 exactly: integer arithmetic keeps the rank from drifting to 58.
    expect(nearestRankPercentile(sixty, 95)).toBe(57);
  });

  it("an empty sample has no percentile, never 0; invalid p is rejected", () => {
    expect(nearestRankPercentile([], 50)).toBeNull();
    expect(() => nearestRankPercentile([1], 0)).toThrow(RangeError);
    expect(() => nearestRankPercentile([1], 99.5)).toThrow(RangeError);
  });
});

/** Deterministic RunMetrics fixtures: completed, completed-with-retry, failed, cancelled, and a nonterminal waiting Run. */
async function fixtures(): Promise<RunMetrics[]> {
  const identity = (runId: string) => ({ runId, workflowId: "wf.metrics", workflowVersion: "1.0.0" });
  const model = { provider: "example", model: "example-model" };
  const traces = [
    await traceOf([[0, d.runStarted("m")], [1, d.nodeStarted("m", 1, 1, "model")], [2, d.modelStarted("m", 1, "inv.1", model)], [3, d.modelCompleted("m", 1, "inv.1", { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 })], [4, d.nodeCompleted("m", 1, 1, "model")], [10, d.runCompleted(1)]], identity("run.a.completed")),
    await traceOf([[0, d.runStarted("lookup")], [1, d.checkpoint(0)], [2, d.nodeStarted("lookup", 1, 1, "tool")], [3, d.toolStarted("lookup", 1, 1, "tool.x")], [4, d.toolFailed("lookup", 1, 1, "tool.x")], [5, d.retryScheduled("lookup", 1, 1)], [6, d.nodeStarted("lookup", 1, 2, "tool")], [7, d.toolStarted("lookup", 1, 2, "tool.x")], [8, d.toolCompleted("lookup", 1, 2, "tool.x")], [9, d.nodeCompleted("lookup", 1, 2, "tool")], [20, d.runCompleted(1)]], identity("run.b.retry")),
    await traceOf([[0, d.runStarted("approval")], [1, d.checkpoint(0)], [2, d.recoveryStarted(0)], [3, d.nodeStarted("approval", 1, 1, "approval")], [4, d.approvalRequested("approval", 1, "approval:c")], [4, d.nodeWaiting("approval", 1, "approval:c")], [4, d.approvalResolved("approval", "approval:c", "rejected", "2026-10-08T12:00:04.000Z")], [4, d.nodeFailed("approval", 1, 1, "approval", "APPROVAL_REJECTED", "APPROVAL")], [5, d.runFailed("APPROVAL_REJECTED", "APPROVAL", 1)]], identity("run.c.failed")),
    await traceOf([[0, d.runStarted()], [1, d.nodeStarted("a", 1)], [2, d.nodeCompleted("a", 1)], [8, d.runCancelled(1)]], identity("run.d.cancelled")),
    await traceOf([[0, d.runStarted("approval")], [1, d.nodeStarted("approval", 1, 1, "approval")], [2, d.approvalRequested("approval", 1, "approval:e")], [3, d.nodeWaiting("approval", 1, "approval:e")]], identity("run.e.waiting")),
  ];
  return traces.map((trace) => {
    const projection = deriveRunMetrics({ trace, pricing: [examplePricing] });
    if (!projection.ok) throw new Error(projection.code);
    return projection.metrics;
  });
}

describe("aggregateRunMetrics", () => {
  it("produces exact, explicit-denominator aggregates", async () => {
    const result = aggregateRunMetrics({ runs: await fixtures() });
    expect(result.ok).toBe(true);
    const metrics = result.ok ? result.metrics : undefined!;
    expect(metrics.runCount).toBe(5);
    expect(metrics.runs).toEqual({ completed: 2, failed: 1, cancelled: 1, waitingForApproval: 1, running: 0, terminal: 4 });
    // Outcome rates are over terminal Runs, by Run outcome (not failure events).
    expect(metrics.successRate).toEqual({ numerator: 2, denominator: 4, value: 0.5 });
    expect(metrics.failureRate).toEqual({ numerator: 1, denominator: 4, value: 0.25 });
    expect(metrics.cancellationRate).toEqual({ numerator: 1, denominator: 4, value: 0.25 });
    // Durations 10s, 20s, 5s, 8s; the waiting Run has no duration and is excluded, never counted as 0.
    expect(metrics.latency).toEqual({ algorithm: "nearest-rank", eligibleRuns: 4, p50RunDurationMs: 8_000, p95RunDurationMs: 20_000, minRunDurationMs: 5_000, maxRunDurationMs: 20_000 });
    expect(metrics.retries).toEqual({ totalRetries: 1, retryExhaustions: 0, runsWithRetry: 1, retryingRunRate: { numerator: 1, denominator: 5, value: 0.2 } });
    expect(metrics.approvals).toEqual({ runsRequiringApproval: 2, approvalRequiredRunRate: { numerator: 2, denominator: 5, value: 0.4 }, requested: 2, approved: 0, rejected: 1, expired: 0, cancelled: 0, pending: 1 });
    // Durable Runs = Runs whose trace has a checkpoint (b, c); recovered = c.
    expect(metrics.recovery).toEqual({ durableRuns: 2, recoveredRuns: 1, recoveredRunRate: { numerator: 1, denominator: 2, value: 0.5 }, recoveryReplays: 0, reusedOutcomes: 0, recoveryBlocks: 0 });
    expect(metrics.failures).toEqual({
      failedAttempts: 2,
      byCategory: [{ category: "APPROVAL", count: 1 }, { category: "TRANSIENT_DEPENDENCY", count: 1 }],
      byCode: [{ code: "APPROVAL_REJECTED", count: 1 }, { code: "TOOL_EXECUTION_FAILED", count: 1 }],
      runFailuresByCategory: [{ category: "APPROVAL", count: 1 }],
      runFailuresByCode: [{ code: "APPROVAL_REJECTED", count: 1 }],
    });
    expect(metrics.tools).toEqual({ totalToolCalls: 2, logicalExecutions: 1, completed: 1, failed: 1, blocked: 0, byTool: [{ toolId: "local.lookup", toolVersion: "1.0.0", physicalInvocations: 2, logicalExecutions: 1, completed: 1, failed: 1, blocked: 0 }] });
    expect(metrics.tokens).toEqual({ status: "complete", runsWithCompleteUsage: 5, inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100, knownInputTokens: 1_000, knownOutputTokens: 100, knownTotalTokens: 1_100 });
    // (1000 × 3e9 + 100 × 15e9) / 1e6 = 4,500,000 nano-USD. Runs with no model calls have complete (zero) model cost.
    expect(metrics.cost).toEqual({ status: "complete", currency: "USD", estimatedCostNanos: 4_500_000, knownEstimatedCostNanos: 4_500_000, costCompleteRuns: 5, costPartialRuns: 0, costUnavailableRuns: 0, costCoverage: { numerator: 5, denominator: 5, value: 1 }, issues: [] });
    expect(metrics.byWorkflow).toEqual([{ workflowId: "wf.metrics", workflowVersion: "1.0.0", runCount: 5, completed: 2, failed: 1, cancelled: 1 }]);
    expect(metrics.byReliabilityPolicy).toHaveLength(1);
    expect(metrics.byReliabilityPolicy[0]).toMatchObject({ runCount: 5, runsWithRetry: 1 });
    expect(AggregateMetricsSchema.parse(JSON.parse(JSON.stringify(metrics)))).toEqual(metrics);
  });

  it("is deterministic and independent of input order", async () => {
    const runs = await fixtures();
    expect(aggregateRunMetrics({ runs: [...runs].reverse() })).toEqual(aggregateRunMetrics({ runs }));
  });

  it("keeps cost coverage explicit when some Runs cannot be priced", async () => {
    const runs = await fixtures();
    const unpriced = deriveRunMetrics({ trace: await traceOf([[0, d.runStarted("m")], [1, d.nodeStarted("m", 1, 1, "model")], [2, d.modelStarted("m", 1, "inv.1", { provider: "unpriced", model: "m" })], [3, d.modelCompleted("m", 1, "inv.1", { inputTokens: 1, outputTokens: 1, totalTokens: 2 })], [4, d.nodeCompleted("m", 1, 1, "model")], [5, d.runCompleted(1)]], { runId: "run.f.unpriced", workflowId: "wf.metrics", workflowVersion: "2.0.0" }), pricing: [examplePricing] });
    const result = aggregateRunMetrics({ runs: [...runs, unpriced.ok ? unpriced.metrics : undefined!] });
    const metrics = result.ok ? result.metrics : undefined!;
    expect(metrics.cost).toMatchObject({ status: "partial", estimatedCostNanos: null, knownEstimatedCostNanos: 4_500_000, costCompleteRuns: 5, costUnavailableRuns: 1, costCoverage: { numerator: 5, denominator: 6 }, issues: [{ code: "METRICS_PRICING_PARTIAL" }] });
    // Workflow versions stay separate dimensions.
    expect(metrics.byWorkflow.map((entry) => [entry.workflowVersion, entry.runCount])).toEqual([["1.0.0", 5], ["2.0.0", 1]]);
  });

  it("never sums cost across currencies", async () => {
    const [first] = await fixtures();
    const euro = { ...first!, runId: "run.eur", cost: { ...first!.cost, currency: "EUR" } };
    const result = aggregateRunMetrics({ runs: [first!, euro] });
    expect(result.ok && result.metrics.cost).toMatchObject({ status: "unavailable", currency: null, estimatedCostNanos: null, knownEstimatedCostNanos: null, issues: [{ code: "METRICS_CURRENCY_MISMATCH" }] });
  });

  it("rejects invalid or duplicate RunMetrics instead of double counting", async () => {
    const [first] = await fixtures();
    expect(aggregateRunMetrics({ runs: [first!, first!] })).toEqual({ ok: false, code: "METRICS_DUPLICATE_RUN" });
    expect(aggregateRunMetrics({ runs: [{ ...first!, durationMs: -1 }] })).toEqual({ ok: false, code: "METRICS_INVALID_RUN_METRICS" });
  });

  it("an empty set has null rates and percentiles, never zero", () => {
    const result = aggregateRunMetrics({ runs: [] });
    expect(result.ok && result.metrics.successRate).toEqual({ numerator: 0, denominator: 0, value: null });
    expect(result.ok && result.metrics.latency).toMatchObject({ eligibleRuns: 0, p50RunDurationMs: null, p95RunDurationMs: null });
  });
});
