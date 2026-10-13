import { z } from "zod";
import { FailureCategorySchema, NodeIdSchema, type TraceEvent } from "@aao/contracts";
import { assertion, gradeError, judged, zodConfig, type EvalGrader } from "../grader.js";
import { payload, readTrace, refs } from "../trace-view.js";

const ConfigSchema = z
  .object({
    /** Scope to one Node (default: the whole Run). */
    nodeId: NodeIdSchema.optional(),
    expectedRetries: z.number().int().nonnegative().max(64).optional(),
    maxRetries: z.number().int().nonnegative().max(64).optional(),
    /**
     * Failures in these categories must never be retried. The Trace must
     * contain at least one such failure; otherwise the case does not
     * exercise the rule and the result is `error`, never a vacuous pass.
     */
    noRetryForCategories: z.array(FailureCategorySchema).min(1).max(16).optional(),
    expectExhausted: z.boolean().optional(),
  })
  .strict()
  .refine((config) => config.expectedRetries !== undefined || config.maxRetries !== undefined || config.noRetryForCategories !== undefined || config.expectExhausted !== undefined, "at least one criterion")
  .refine((config) => !config.noRetryForCategories || new Set(config.noRetryForCategories).size === config.noRetryForCategories.length, "categories must be unique");
type Config = z.infer<typeof ConfigSchema>;

const CATEGORY_EVENTS = new Set(["node.failed", "tool.call.failed", "tool.call.blocked", "retry.scheduled", "retry.exhausted", "run.failed", "failure.detected"]);

/**
 * `aao.retry-behavior` — retries are counted from `retry.scheduled` /
 * `retry.exhausted`, never inferred from Node starts. The whole Run must be
 * traced (a terminal event): a Run that has not finished could still retry,
 * so a partial Trace is `error`.
 */
export function createRetryBehaviorGrader(): EvalGrader<Config> {
  return {
    id: "aao.retry-behavior",
    version: "1.0.0",
    supportedModes: ["OFFLINE", "RUNTIME"],
    supportedTargetTypes: ["run", "node"],
    validateConfig: zodConfig(ConfigSchema),
    evaluate({ config, evidence }) {
      const read = readTrace(evidence, { requireTerminal: true });
      if (!read.ok) return read.outcome;
      const scoped = read.view.events.filter((event) => config.nodeId === undefined || event.nodeId === config.nodeId);
      const scheduled = scoped.filter((event) => event.type === "retry.scheduled");
      const exhausted = scoped.filter((event) => event.type === "retry.exhausted");
      const assertions = [];

      if (config.expectedRetries !== undefined) assertions.push(assertion("retry.count", scheduled.length === config.expectedRetries, { reasonCode: "RETRY_COUNT_MISMATCH", evidenceRefs: refs(scheduled) }));
      if (config.maxRetries !== undefined) assertions.push(assertion("retry.max", scheduled.length <= config.maxRetries, { reasonCode: "RETRY_LIMIT_EXCEEDED", evidenceRefs: refs(scheduled) }));
      if (config.noRetryForCategories) {
        const categories = config.noRetryForCategories;
        const triggering = scoped.filter((event: TraceEvent) => CATEGORY_EVENTS.has(event.type) && categories.includes(payload(event).category as never));
        if (triggering.length === 0) return gradeError("EVAL_EVIDENCE_MISSING");
        const forbidden = scheduled.filter((event) => categories.includes(payload(event).category as never));
        assertions.push(assertion("retry.forbidden-category", forbidden.length === 0, { reasonCode: "RETRY_FORBIDDEN_CATEGORY", evidenceRefs: refs(forbidden.length > 0 ? forbidden : triggering) }));
      }
      if (config.expectExhausted !== undefined) {
        const ok = config.expectExhausted ? exhausted.length > 0 : exhausted.length === 0;
        assertions.push(assertion("retry.exhaustion", ok, { reasonCode: config.expectExhausted ? "RETRY_NOT_EXHAUSTED" : "RETRY_EXHAUSTED_UNEXPECTEDLY", evidenceRefs: refs(exhausted) }));
      }
      return judged(assertions);
    },
  };
}
