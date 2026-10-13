import { z } from "zod";
import { RunMetricsSchema, type RunMetrics } from "@aao/contracts";
import { evidenceRefs } from "../evidence.js";
import { assertion, gradeError, judged, zodConfig, type EvalGrader } from "../grader.js";

const limit = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const ConfigSchema = z
  .object({
    maxRunDurationMs: limit.optional(),
    maxRunDurationExcludingApprovalWaitMs: limit.optional(),
    maxApprovalWaitMs: limit.optional(),
    maxRetries: limit.optional(),
    maxFailedAttempts: limit.optional(),
    maxPhysicalToolCalls: limit.optional(),
    maxLogicalToolExecutions: limit.optional(),
    maxTotalTokens: limit.optional(),
    /** Modelled cost in integer nano-units of the Metrics' currency. */
    maxEstimatedCostNanos: limit.optional(),
  })
  .strict()
  .refine((config) => Object.values(config).some((value) => value !== undefined), "at least one threshold");
type Config = z.infer<typeof ConfigSchema>;
type Threshold = keyof Config;

/**
 * Each threshold reads one Trace-derived RunMetrics measurement. A
 * measurement is usable only when it is complete: `null` duration, partial
 * or unavailable tokens/cost, or a `partial` Trace (counts may be lower
 * bounds) yields `null` here.
 */
const MEASURE: Record<Threshold, { id: string; read: (metrics: RunMetrics) => number | null }> = {
  maxRunDurationMs: { id: "metrics.run-duration", read: (metrics) => metrics.durationMs },
  maxRunDurationExcludingApprovalWaitMs: { id: "metrics.run-duration-excluding-approval-wait", read: (metrics) => metrics.durationExcludingApprovalWaitMs },
  maxApprovalWaitMs: { id: "metrics.approval-wait", read: (metrics) => metrics.approvalWaitDurationMs },
  maxRetries: { id: "metrics.retries", read: (metrics) => metrics.retries.scheduled },
  maxFailedAttempts: { id: "metrics.failed-attempts", read: (metrics) => metrics.failures.failedAttempts },
  maxPhysicalToolCalls: { id: "metrics.physical-tool-calls", read: (metrics) => metrics.tools.physicalInvocations },
  maxLogicalToolExecutions: { id: "metrics.logical-tool-executions", read: (metrics) => metrics.tools.logicalExecutions },
  maxTotalTokens: { id: "metrics.total-tokens", read: (metrics) => (metrics.tokenUsage.status === "complete" ? metrics.tokenUsage.totalTokens : null) },
  maxEstimatedCostNanos: { id: "metrics.estimated-cost", read: (metrics) => (metrics.cost.status === "complete" ? metrics.cost.estimatedCostNanos : null) },
};

/**
 * `aao.metrics-threshold` — deterministic operational limits over
 * RunMetrics. Missing measurement is not proof of compliance: if any
 * configured threshold's measurement is incomplete (e.g. cost `partial` or
 * `unavailable`), the result is `error` with
 * `EVAL_REQUIRED_EVIDENCE_INCOMPLETE`, never `passed`. Evaluation reads
 * Metrics; it never recomputes or rewrites them.
 */
export function createMetricsThresholdGrader(): EvalGrader<Config> {
  return {
    id: "aao.metrics-threshold",
    version: "1.0.0",
    supportedModes: ["OFFLINE", "RUNTIME"],
    supportedTargetTypes: ["run"],
    validateConfig: zodConfig(ConfigSchema),
    evaluate({ config, evidence }) {
      if (evidence.metrics === undefined) return gradeError("EVAL_EVIDENCE_MISSING");
      const parsed = RunMetricsSchema.safeParse(evidence.metrics);
      if (!parsed.success) return gradeError("EVAL_EVIDENCE_INVALID");
      const metrics = parsed.data;
      const metricsRef = evidenceRefs.metrics(metrics.runId);
      if (metrics.traceQuality.status !== "complete") return gradeError("EVAL_REQUIRED_EVIDENCE_INCOMPLETE", [metricsRef]);
      const thresholds = (Object.keys(MEASURE) as Threshold[]).filter((key) => config[key] !== undefined);
      const measured = thresholds.map((key) => ({ key, value: MEASURE[key].read(metrics) }));
      if (measured.some((entry) => entry.value === null)) return gradeError("EVAL_REQUIRED_EVIDENCE_INCOMPLETE", [metricsRef]);
      return judged(measured.map(({ key, value }) => assertion(MEASURE[key].id, value! <= config[key]!, { reasonCode: "METRIC_THRESHOLD_EXCEEDED", evidenceRefs: [metricsRef] })));
    },
  };
}
