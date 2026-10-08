import { z } from "zod";
import { NodeIdSchema, RunIdSchema, ToolIdSchema, WorkflowIdSchema, entityVersionSchema, identifierSchema, isoTimestampSchema, schemaVersionSchema } from "./common.js";
import { FailureCategorySchema } from "./reliability.js";
import { NodeKindSchema } from "./workflow.js";

/**
 * Canonical AAO Metrics contracts (ADR-021, docs/architecture/metrics.md).
 * Metrics are *derived quantitative measurements*: deterministic projections
 * of validated Trace evidence plus explicit trusted pricing configuration.
 * They are never a source of truth, never stored as mutable state, and never
 * read by any execution decision; they can always be recomputed from Trace.
 *
 * Missing evidence stays missing: an unavailable measurement is `null` (or a
 * non-`complete` status), never zero. Metrics measure operational behavior
 * only — not task quality, correctness, or grounding (Evaluation, Sprint 17).
 */

const count = z.number().int().nonnegative();
const nullableCount = count.nullable();
const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const CodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** Bounded Metrics diagnostics. They describe evidence and pricing only; they are never Runtime failure codes. */
export const METRICS_ISSUE_CODES = [
  "METRICS_INVALID_TRACE",
  "METRICS_INCOMPLETE_TRACE",
  "METRICS_USAGE_INCOMPLETE",
  "METRICS_PRICING_UNAVAILABLE",
  "METRICS_PRICING_PARTIAL",
  "METRICS_INVALID_PRICING_PROFILE",
  "METRICS_INVALID_RUN_METRICS",
  "METRICS_DUPLICATE_RUN",
  "METRICS_CURRENCY_MISMATCH",
  "METRICS_COST_OVERFLOW",
] as const;
export const MetricsIssueCodeSchema = z.enum(METRICS_ISSUE_CODES);
export type MetricsIssueCode = z.infer<typeof MetricsIssueCodeSchema>;

/** A ratio that always names its denominator. `value` is null when the denominator is 0 — never a fabricated 0 or 1. */
export const MetricRateSchema = z.object({ numerator: count, denominator: count, value: z.number().min(0).max(1).nullable() }).strict();
export type MetricRate = z.infer<typeof MetricRateSchema>;

/** Completeness of a derived quantity: every input reported it, some did, or none did. */
export const MetricCompletenessSchema = z.enum(["complete", "partial", "unavailable"]);
export type MetricCompleteness = z.infer<typeof MetricCompletenessSchema>;

// --- Pricing ------------------------------------------------------------------------

/**
 * Trusted, version-controlled model pricing (host configuration only — never
 * model, Agent, Tool, MCP, memory, workflow-state, or Trace supplied).
 * Prices are integers in nano-units of `currency` (1e-9) per one million
 * tokens, so accounting never depends on binary floating point. A profile
 * matches a model call only on exact registered `provider` + `model`, and on
 * exact `revision` when the profile names one. No substring matching, no
 * Internet or provider lookup. Pricing is observability metadata: changing
 * it never affects execution, durability, permissions, or recovery, and the
 * same Trace can be re-priced for analysis.
 */
export const ModelPricingProfileSchema = z
  .object({
    schemaVersion: schemaVersionSchema(1),
    profileId: identifierSchema,
    profileVersion: entityVersionSchema,
    provider: identifierSchema.max(128),
    model: z.string().min(1).max(128),
    revision: z.string().min(1).max(128).optional(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    inputNanosPerMillionTokens: z.number().int().nonnegative().max(MAX_SAFE),
    outputNanosPerMillionTokens: z.number().int().nonnegative().max(MAX_SAFE),
  })
  .strict();
export type ModelPricingProfile = z.infer<typeof ModelPricingProfileSchema>;

/** Registered model identity as traced (`ModelBinding.identity`); `null` buckets calls whose binding registered none. */
export const MetricsModelIdentitySchema = z.object({ provider: identifierSchema.max(128), model: z.string().min(1).max(128), revision: z.string().min(1).max(128).optional() }).strict();

export const UnpricedReasonSchema = z.enum(["MODEL_IDENTITY_MISSING", "PRICING_PROFILE_NOT_FOUND", "USAGE_MISSING", "CALL_FAILED"]);

/**
 * Modelled (estimated) model-token cost. It is not an invoice or provider
 * billing truth: negotiated rates, caching or batch discounts, provider
 * rounding, taxes, and credits are not represented. Each priced call is
 * rounded half-up to a whole nano-unit, then summed. `estimatedCostNanos`
 * is present only when every model call was priced; otherwise only the
 * explicitly partial `knownEstimatedCostNanos` is available.
 */
export const CostSummarySchema = z
  .object({
    status: MetricCompletenessSchema,
    currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
    estimatedCostNanos: nullableCount,
    knownEstimatedCostNanos: count,
    pricedCalls: count,
    unpricedCalls: count,
    unpricedReasons: z.array(z.object({ reason: UnpricedReasonSchema, count: count }).strict()),
    pricingProfiles: z.array(z.object({ profileId: identifierSchema, profileVersion: entityVersionSchema }).strict()),
  })
  .strict();
export type CostSummary = z.infer<typeof CostSummarySchema>;

/**
 * Deterministic sums of recorded model usage — never estimated from text.
 * A total field is non-null only when every model call reported it.
 * `known*` sums are explicitly partial lower bounds. Failed calls report no
 * usage, so they make accounting `partial`.
 */
export const TokenUsageSummarySchema = z
  .object({
    status: MetricCompletenessSchema,
    modelCallsCompleted: count,
    modelCallsFailed: count,
    callsWithUsage: count,
    callsWithoutUsage: count,
    inputTokens: nullableCount,
    outputTokens: nullableCount,
    totalTokens: nullableCount,
    knownInputTokens: count,
    knownOutputTokens: count,
    knownTotalTokens: count,
  })
  .strict();
export type TokenUsageSummary = z.infer<typeof TokenUsageSummarySchema>;

const CategoryCountSchema = z.object({ category: FailureCategorySchema, count: count }).strict();
const CodeCountSchema = z.object({ code: CodeSchema, count: count }).strict();

export const ModelMetricsBreakdownSchema = z
  .object({
    identity: MetricsModelIdentitySchema.nullable(),
    callsStarted: count,
    callsCompleted: count,
    callsFailed: count,
    callsWithoutUsage: count,
    knownInputTokens: count,
    knownOutputTokens: count,
    knownTotalTokens: count,
    pricedCalls: count,
    unpricedCalls: count,
    knownEstimatedCostNanos: count,
  })
  .strict();
export type ModelMetricsBreakdown = z.infer<typeof ModelMetricsBreakdownSchema>;

/** Physical invocations count handler starts; logical executions count distinct `toolExecutionId`s (a recovery replay is 2 physical, 1 logical). */
export const ToolMetricsBreakdownSchema = z
  .object({ toolId: ToolIdSchema, toolVersion: entityVersionSchema, physicalInvocations: count, logicalExecutions: count, completed: count, failed: count, blocked: count })
  .strict();
export type ToolMetricsBreakdown = z.infer<typeof ToolMetricsBreakdownSchema>;

// --- Run Metrics ----------------------------------------------------------------------

/** The Run's status as evidenced by its Trace. Runtime state stays the only lifecycle truth. */
export const MetricsRunStatusSchema = z.enum(["COMPLETED", "FAILED", "CANCELLED", "WAITING_FOR_APPROVAL", "RUNNING"]);
export type MetricsRunStatus = z.infer<typeof MetricsRunStatusSchema>;

/**
 * One Node attempt, paired by its attempt span (Node + step + attempt).
 * `durationMs` runs from `node.started` to the attempt's first end marker
 * (`node.completed`/`failed`/`waiting` or `retry.scheduled`); a recovered
 * attempt includes the recovery gap. `waitDurationMs` runs from
 * `node.waiting` to the Trace's `approval.resolved` (Runtime consumption) —
 * time blocked on approval, not executor latency and not human response
 * time. Separate attempts are never merged.
 */
export const NodeAttemptMetricsSchema = z
  .object({
    nodeId: NodeIdSchema,
    kind: NodeKindSchema,
    step: count,
    attempt: count,
    recoveryReplay: z.boolean(),
    outcome: z.enum(["completed", "failed", "retried", "waiting", "open"]),
    startedAt: isoTimestampSchema,
    durationMs: nullableCount,
    waitDurationMs: nullableCount,
  })
  .strict();
export type NodeAttemptMetrics = z.infer<typeof NodeAttemptMetricsSchema>;

export const RunMetricsSchema = z
  .object({
    schemaVersion: schemaVersionSchema(1),
    runId: RunIdSchema,
    traceId: z.string().regex(/^[a-f0-9]{32}$/),
    workflowId: WorkflowIdSchema,
    workflowVersion: entityVersionSchema,
    /** Optional diagnostic dimensions, present only when the Trace carries them. Never required, never invented. */
    dimensions: z
      .object({ reliabilityPolicyFingerprint: hex64.optional(), releaseId: identifierSchema.optional(), gitSha: z.string().regex(/^[a-f0-9]{7,64}$/).optional(), environment: identifierSchema.max(64).optional() })
      .strict(),
    runStatus: MetricsRunStatusSchema,
    /** Evidence quality: `partial` when the recorder reported this Run's trace degraded. An invalid trace yields no RunMetrics at all. */
    traceQuality: z.object({ status: z.enum(["complete", "partial"]), issues: z.array(z.object({ code: MetricsIssueCodeSchema }).strict()) }).strict(),
    startedAt: isoTimestampSchema,
    endedAt: isoTimestampSchema.nullable(),
    /** `run.started` → terminal Run event. Never from checkpoint timing. Null without a terminal event. */
    durationMs: nullableCount,
    /** Sum of approval waits (see NodeAttemptMetrics); null while any wait is unresolved in the trace. */
    approvalWaitDurationMs: nullableCount,
    /** `durationMs − approvalWaitDurationMs`: wall time not blocked on approval (includes any recovery downtime). */
    durationExcludingApprovalWaitMs: nullableCount,
    steps: nullableCount,
    nodes: z
      .object({
        executions: count,
        attempts: count,
        recoveryReplayAttempts: count,
        completed: count,
        failed: count,
        waiting: count,
        attemptDetails: z.array(NodeAttemptMetricsSchema),
        byNode: z.array(z.object({ nodeId: NodeIdSchema, kind: NodeKindSchema, executions: count, attempts: count, completed: count, failed: count, waits: count, attemptDurationMsTotal: nullableCount }).strict()),
      })
      .strict(),
    retries: z.object({ scheduled: count, exhausted: count, nodesRetried: count }).strict(),
    models: z.object({ callsStarted: count, callsCompleted: count, callsFailed: count, byModel: z.array(ModelMetricsBreakdownSchema) }).strict(),
    agents: z.object({ executions: count, iterations: count, completed: count, failed: count }).strict(),
    tools: z.object({ physicalInvocations: count, logicalExecutions: count, completed: count, failed: count, blocked: count, byTool: z.array(ToolMetricsBreakdownSchema) }).strict(),
    approvals: z.object({ requested: count, approved: count, rejected: count, expired: count, cancelled: count, pending: count }).strict(),
    durability: z.object({ checkpointsCreated: count, recoveryStarts: count, recoveryReplays: count, reusedOutcomes: count, recoveryBlocks: count, recoveryCompletions: count }).strict(),
    cancellation: z.object({ requested: z.boolean(), applied: z.boolean() }).strict(),
    state: z.object({ updates: count, finalStateRevision: count }).strict(),
    tokenUsage: TokenUsageSummarySchema,
    cost: CostSummarySchema,
    /**
     * Failed Node attempts (`retry.scheduled` + `node.failed`) by the existing
     * `FailureCategory` and the most specific existing code. `runFailure` is
     * the Run outcome; `detectedEvents` counts `failure.detected` events.
     */
    failures: z
      .object({ failedAttempts: count, uncategorizedAttempts: count, byCategory: z.array(CategoryCountSchema), byCode: z.array(CodeCountSchema), detectedEvents: count, runFailure: z.object({ code: CodeSchema, category: FailureCategorySchema.optional() }).strict().nullable() })
      .strict(),
  })
  .strict();
export type RunMetrics = z.infer<typeof RunMetricsSchema>;

// --- Aggregate Metrics ------------------------------------------------------------------

/**
 * A deterministic aggregate over `RunMetrics[]` (never over Trace or Audit
 * directly). Every rate names its denominator; percentiles use nearest-rank
 * over Runs with a terminal duration only (`latency.eligibleRuns`).
 */
export const AggregateMetricsSchema = z
  .object({
    schemaVersion: schemaVersionSchema(1),
    runCount: count,
    runs: z.object({ completed: count, failed: count, cancelled: count, waitingForApproval: count, running: count, terminal: count }).strict(),
    traceQuality: z.object({ complete: count, partial: count }).strict(),
    /** completed / terminal Runs. */
    successRate: MetricRateSchema,
    /** failed / terminal Runs — by Run outcome, never by failure-event count. */
    failureRate: MetricRateSchema,
    /** cancelled / terminal Runs. */
    cancellationRate: MetricRateSchema,
    latency: z.object({ algorithm: z.literal("nearest-rank"), eligibleRuns: count, p50RunDurationMs: nullableCount, p95RunDurationMs: nullableCount, minRunDurationMs: nullableCount, maxRunDurationMs: nullableCount }).strict(),
    /** `retryingRunRate` = Runs with ≥ 1 `retry.scheduled` / all Runs. */
    retries: z.object({ totalRetries: count, retryExhaustions: count, runsWithRetry: count, retryingRunRate: MetricRateSchema }).strict(),
    /** `approvalRequiredRunRate` = Runs with ≥ 1 `approval.requested` / all Runs. Decisions are a separate breakdown. */
    approvals: z.object({ runsRequiringApproval: count, approvalRequiredRunRate: MetricRateSchema, requested: count, approved: count, rejected: count, expired: count, cancelled: count, pending: count }).strict(),
    /** `recoveredRunRate` = Runs with ≥ 1 `recovery.started` / durable Runs (Runs whose trace has ≥ 1 `checkpoint.created`). */
    recovery: z.object({ durableRuns: count, recoveredRuns: count, recoveredRunRate: MetricRateSchema, recoveryReplays: count, reusedOutcomes: count, recoveryBlocks: count }).strict(),
    models: z.object({ totalModelCalls: count, completed: count, failed: count, byModel: z.array(ModelMetricsBreakdownSchema) }).strict(),
    tools: z.object({ totalToolCalls: count, logicalExecutions: count, completed: count, failed: count, blocked: count, byTool: z.array(ToolMetricsBreakdownSchema) }).strict(),
    tokens: z.object({ status: MetricCompletenessSchema, runsWithCompleteUsage: count, inputTokens: nullableCount, outputTokens: nullableCount, totalTokens: nullableCount, knownInputTokens: count, knownOutputTokens: count, knownTotalTokens: count }).strict(),
    /** `costCoverage` = Runs whose modelled cost is complete / all Runs. */
    cost: z.object({ status: MetricCompletenessSchema, currency: z.string().regex(/^[A-Z]{3}$/).nullable(), estimatedCostNanos: nullableCount, knownEstimatedCostNanos: nullableCount, costCompleteRuns: count, costPartialRuns: count, costUnavailableRuns: count, costCoverage: MetricRateSchema, issues: z.array(z.object({ code: MetricsIssueCodeSchema }).strict()) }).strict(),
    failures: z.object({ failedAttempts: count, byCategory: z.array(CategoryCountSchema), byCode: z.array(CodeCountSchema), runFailuresByCategory: z.array(CategoryCountSchema), runFailuresByCode: z.array(CodeCountSchema) }).strict(),
    byWorkflow: z.array(z.object({ workflowId: WorkflowIdSchema, workflowVersion: entityVersionSchema, runCount: count, completed: count, failed: count, cancelled: count }).strict()),
    byReliabilityPolicy: z.array(z.object({ reliabilityPolicyFingerprint: hex64.nullable(), runCount: count, completed: count, failed: count, cancelled: count, runsWithRetry: count }).strict()),
  })
  .strict();
export type AggregateMetrics = z.infer<typeof AggregateMetricsSchema>;
