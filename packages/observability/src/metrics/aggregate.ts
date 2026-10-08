import { AggregateMetricsSchema, RunMetricsSchema, type AggregateMetrics, type MetricCompleteness, type MetricRate, type ModelMetricsBreakdown, type RunMetrics, type ToolMetricsBreakdown } from "@aao/contracts";
import { nearestRankPercentile } from "./percentile.js";

/**
 * RunMetrics[] → AggregateMetrics (ADR-021). Pure and deterministic. It
 * aggregates derived RunMetrics only — never Trace files and never Audit
 * events — so storage adapters and tests stay simple. Every rate names its
 * denominator; Run-outcome rates count Runs, not failure events; latency
 * percentiles use nearest-rank over Runs with a terminal duration only.
 */
export type AggregateMetricsResult = { ok: true; metrics: AggregateMetrics } | { ok: false; code: "METRICS_INVALID_RUN_METRICS" | "METRICS_DUPLICATE_RUN" };

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

export function rate(numerator: number, denominator: number): MetricRate {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}

function mergeCounts<K extends string>(lists: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>, field: string): Array<Record<string, K | number>> {
  const totals = new Map<string, number>();
  for (const list of lists) for (const entry of list) totals.set(entry[field] as string, (totals.get(entry[field] as string) ?? 0) + (entry.count as number));
  return [...totals.entries()].sort(([a], [b]) => cmp(a, b)).map(([key, value]) => ({ [field]: key as K, count: value }));
}

/** Overall completeness of a per-Run quantity: complete only if every Run is; unavailable only if every Run is. */
function overall(statuses: readonly MetricCompleteness[]): MetricCompleteness {
  if (statuses.every((status) => status === "complete")) return "complete";
  if (statuses.every((status) => status === "unavailable")) return "unavailable";
  return "partial";
}

export function aggregateRunMetrics(params: { runs: readonly unknown[] }): AggregateMetricsResult {
  const runs: RunMetrics[] = [];
  const ids = new Set<string>();
  for (const candidate of params.runs ?? []) {
    const parsed = RunMetricsSchema.safeParse(candidate);
    if (!parsed.success) return { ok: false, code: "METRICS_INVALID_RUN_METRICS" };
    if (ids.has(parsed.data.runId)) return { ok: false, code: "METRICS_DUPLICATE_RUN" };
    ids.add(parsed.data.runId);
    runs.push(parsed.data as RunMetrics);
  }
  const n = runs.length;
  const withStatus = (status: RunMetrics["runStatus"]) => runs.filter((run) => run.runStatus === status).length;
  const completed = withStatus("COMPLETED");
  const failed = withStatus("FAILED");
  const cancelled = withStatus("CANCELLED");
  const terminal = completed + failed + cancelled;

  const durations = runs.filter((run) => run.durationMs !== null).map((run) => run.durationMs!);
  const runsWithRetry = runs.filter((run) => run.retries.scheduled > 0).length;
  const runsRequiringApproval = runs.filter((run) => run.approvals.requested > 0).length;
  const durableRuns = runs.filter((run) => run.durability.checkpointsCreated > 0);
  const recoveredRuns = durableRuns.filter((run) => run.durability.recoveryStarts > 0).length;

  // Models: merge by exact registered identity (unregistered calls stay their own bucket).
  const models = new Map<string, ModelMetricsBreakdown>();
  for (const entry of runs.flatMap((run) => run.models.byModel)) {
    const key = entry.identity ? JSON.stringify([entry.identity.provider, entry.identity.model, entry.identity.revision ?? null]) : "~unregistered";
    const prior = models.get(key);
    models.set(key, prior ? { identity: prior.identity, callsStarted: prior.callsStarted + entry.callsStarted, callsCompleted: prior.callsCompleted + entry.callsCompleted, callsFailed: prior.callsFailed + entry.callsFailed, callsWithoutUsage: prior.callsWithoutUsage + entry.callsWithoutUsage, knownInputTokens: prior.knownInputTokens + entry.knownInputTokens, knownOutputTokens: prior.knownOutputTokens + entry.knownOutputTokens, knownTotalTokens: prior.knownTotalTokens + entry.knownTotalTokens, pricedCalls: prior.pricedCalls + entry.pricedCalls, unpricedCalls: prior.unpricedCalls + entry.unpricedCalls, knownEstimatedCostNanos: prior.knownEstimatedCostNanos + entry.knownEstimatedCostNanos } : { ...entry });
  }
  // Tools: merge by exact id + version.
  const tools = new Map<string, ToolMetricsBreakdown>();
  for (const entry of runs.flatMap((run) => run.tools.byTool)) {
    const key = JSON.stringify([entry.toolId, entry.toolVersion]);
    const prior = tools.get(key);
    tools.set(key, prior ? { toolId: prior.toolId, toolVersion: prior.toolVersion, physicalInvocations: prior.physicalInvocations + entry.physicalInvocations, logicalExecutions: prior.logicalExecutions + entry.logicalExecutions, completed: prior.completed + entry.completed, failed: prior.failed + entry.failed, blocked: prior.blocked + entry.blocked } : { ...entry });
  }

  // Tokens: a total exists only when every Run's total exists.
  const totalOrNull = (pick: (run: RunMetrics) => number | null) => (runs.every((run) => pick(run) !== null) ? sum(runs.map((run) => pick(run)!)) : null);

  // Cost: never summed across currencies; unknown stays unknown.
  const currencies = [...new Set(runs.map((run) => run.cost.currency).filter((currency): currency is string => currency !== null))].sort(cmp);
  const mixed = currencies.length > 1;
  const costStatuses = runs.map((run) => run.cost.status);
  const costStatus = mixed ? "unavailable" : overall(costStatuses);
  const knownCost = mixed ? null : sum(runs.map((run) => run.cost.knownEstimatedCostNanos));
  const costIssues = [...(mixed ? [{ code: "METRICS_CURRENCY_MISMATCH" as const }] : []), ...(!mixed && costStatus === "partial" ? [{ code: "METRICS_PRICING_PARTIAL" as const }] : []), ...(!mixed && costStatus === "unavailable" ? [{ code: "METRICS_PRICING_UNAVAILABLE" as const }] : [])];

  const workflows = new Map<string, AggregateMetrics["byWorkflow"][number]>();
  const policies = new Map<string, AggregateMetrics["byReliabilityPolicy"][number]>();
  for (const run of runs) {
    const outcome = { completed: run.runStatus === "COMPLETED" ? 1 : 0, failed: run.runStatus === "FAILED" ? 1 : 0, cancelled: run.runStatus === "CANCELLED" ? 1 : 0 };
    const workflowKey = JSON.stringify([run.workflowId, run.workflowVersion]);
    const workflow = workflows.get(workflowKey) ?? { workflowId: run.workflowId, workflowVersion: run.workflowVersion, runCount: 0, completed: 0, failed: 0, cancelled: 0 };
    workflows.set(workflowKey, { ...workflow, runCount: workflow.runCount + 1, completed: workflow.completed + outcome.completed, failed: workflow.failed + outcome.failed, cancelled: workflow.cancelled + outcome.cancelled });
    const fingerprint = run.dimensions.reliabilityPolicyFingerprint ?? null;
    const policyKey = fingerprint ?? "~none";
    const policy = policies.get(policyKey) ?? { reliabilityPolicyFingerprint: fingerprint, runCount: 0, completed: 0, failed: 0, cancelled: 0, runsWithRetry: 0 };
    policies.set(policyKey, { ...policy, runCount: policy.runCount + 1, completed: policy.completed + outcome.completed, failed: policy.failed + outcome.failed, cancelled: policy.cancelled + outcome.cancelled, runsWithRetry: policy.runsWithRetry + (run.retries.scheduled > 0 ? 1 : 0) });
  }

  const runFailures = runs.map((run) => run.failures.runFailure).filter((failure): failure is NonNullable<RunMetrics["failures"]["runFailure"]> => failure !== null);
  const metrics: AggregateMetrics = {
    schemaVersion: 1,
    runCount: n,
    runs: { completed, failed, cancelled, waitingForApproval: withStatus("WAITING_FOR_APPROVAL"), running: withStatus("RUNNING"), terminal },
    traceQuality: { complete: runs.filter((run) => run.traceQuality.status === "complete").length, partial: runs.filter((run) => run.traceQuality.status === "partial").length },
    successRate: rate(completed, terminal),
    failureRate: rate(failed, terminal),
    cancellationRate: rate(cancelled, terminal),
    latency: { algorithm: "nearest-rank", eligibleRuns: durations.length, p50RunDurationMs: nearestRankPercentile(durations, 50), p95RunDurationMs: nearestRankPercentile(durations, 95), minRunDurationMs: durations.length ? Math.min(...durations) : null, maxRunDurationMs: durations.length ? Math.max(...durations) : null },
    retries: { totalRetries: sum(runs.map((run) => run.retries.scheduled)), retryExhaustions: sum(runs.map((run) => run.retries.exhausted)), runsWithRetry, retryingRunRate: rate(runsWithRetry, n) },
    approvals: {
      runsRequiringApproval,
      approvalRequiredRunRate: rate(runsRequiringApproval, n),
      requested: sum(runs.map((run) => run.approvals.requested)),
      approved: sum(runs.map((run) => run.approvals.approved)),
      rejected: sum(runs.map((run) => run.approvals.rejected)),
      expired: sum(runs.map((run) => run.approvals.expired)),
      cancelled: sum(runs.map((run) => run.approvals.cancelled)),
      pending: sum(runs.map((run) => run.approvals.pending)),
    },
    recovery: { durableRuns: durableRuns.length, recoveredRuns, recoveredRunRate: rate(recoveredRuns, durableRuns.length), recoveryReplays: sum(runs.map((run) => run.durability.recoveryReplays)), reusedOutcomes: sum(runs.map((run) => run.durability.reusedOutcomes)), recoveryBlocks: sum(runs.map((run) => run.durability.recoveryBlocks)) },
    models: { totalModelCalls: sum(runs.map((run) => run.models.callsStarted)), completed: sum(runs.map((run) => run.models.callsCompleted)), failed: sum(runs.map((run) => run.models.callsFailed)), byModel: [...models.entries()].sort(([a], [b]) => cmp(a, b)).map(([, entry]) => entry) },
    tools: { totalToolCalls: sum(runs.map((run) => run.tools.physicalInvocations)), logicalExecutions: sum(runs.map((run) => run.tools.logicalExecutions)), completed: sum(runs.map((run) => run.tools.completed)), failed: sum(runs.map((run) => run.tools.failed)), blocked: sum(runs.map((run) => run.tools.blocked)), byTool: [...tools.entries()].sort(([a], [b]) => cmp(a, b)).map(([, entry]) => entry) },
    tokens: {
      status: overall(runs.map((run) => run.tokenUsage.status)),
      runsWithCompleteUsage: runs.filter((run) => run.tokenUsage.status === "complete").length,
      inputTokens: totalOrNull((run) => run.tokenUsage.inputTokens),
      outputTokens: totalOrNull((run) => run.tokenUsage.outputTokens),
      totalTokens: totalOrNull((run) => run.tokenUsage.totalTokens),
      knownInputTokens: sum(runs.map((run) => run.tokenUsage.knownInputTokens)),
      knownOutputTokens: sum(runs.map((run) => run.tokenUsage.knownOutputTokens)),
      knownTotalTokens: sum(runs.map((run) => run.tokenUsage.knownTotalTokens)),
    },
    cost: {
      status: costStatus,
      currency: mixed ? null : (currencies[0] ?? null),
      estimatedCostNanos: costStatus === "complete" ? knownCost : null,
      knownEstimatedCostNanos: knownCost,
      costCompleteRuns: costStatuses.filter((status) => status === "complete").length,
      costPartialRuns: costStatuses.filter((status) => status === "partial").length,
      costUnavailableRuns: costStatuses.filter((status) => status === "unavailable").length,
      costCoverage: rate(costStatuses.filter((status) => status === "complete").length, n),
      issues: costIssues,
    },
    failures: {
      failedAttempts: sum(runs.map((run) => run.failures.failedAttempts)),
      byCategory: mergeCounts(runs.map((run) => run.failures.byCategory), "category") as AggregateMetrics["failures"]["byCategory"],
      byCode: mergeCounts(runs.map((run) => run.failures.byCode), "code") as AggregateMetrics["failures"]["byCode"],
      runFailuresByCategory: mergeCounts([runFailures.filter((failure) => failure.category).map((failure) => ({ category: failure.category, count: 1 }))], "category") as AggregateMetrics["failures"]["runFailuresByCategory"],
      runFailuresByCode: mergeCounts([runFailures.map((failure) => ({ code: failure.code, count: 1 }))], "code") as AggregateMetrics["failures"]["runFailuresByCode"],
    },
    byWorkflow: [...workflows.entries()].sort(([a], [b]) => cmp(a, b)).map(([, entry]) => entry),
    byReliabilityPolicy: [...policies.entries()].sort(([a], [b]) => cmp(a, b)).map(([, entry]) => entry),
  };
  return { ok: true, metrics: AggregateMetricsSchema.parse(metrics) as AggregateMetrics };
}
