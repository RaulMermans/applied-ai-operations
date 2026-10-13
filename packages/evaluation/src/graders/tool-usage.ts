import { z } from "zod";
import { EvalReasonCodeSchema, type TraceEvent } from "@aao/contracts";
import { assertion, judged, zodConfig, type EvalGrader } from "../grader.js";
import { ToolRefConfigSchema, isTool, payload, readTrace, refs, toolKey, uniqueBy, type ToolRefConfig } from "../trace-view.js";

const CallLimitSchema = z
  .object({
    /** Absent: all Tools together. */
    tool: ToolRefConfigSchema.optional(),
    /** `physical`: handler starts (`tool.call.started`, recovery replays included). `logical`: distinct `toolExecutionId`s. */
    count: z.enum(["physical", "logical"]),
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((limit) => limit.min !== undefined || limit.max !== undefined, "min or max")
  .refine((limit) => limit.min === undefined || limit.max === undefined || limit.min <= limit.max, "min ≤ max");

const ExpectationSchema = z.object({ tool: ToolRefConfigSchema, failureCode: EvalReasonCodeSchema.optional() }).strict();

const ConfigSchema = z
  .object({
    requiredTools: z.array(ToolRefConfigSchema).min(1).max(32).optional(),
    forbiddenTools: z.array(ToolRefConfigSchema).min(1).max(32).optional(),
    callLimits: z.array(CallLimitSchema).min(1).max(32).optional(),
    /** Tools whose first invocations must occur in this order (ordered subsequence of logical executions). */
    requiredOrder: z.array(ToolRefConfigSchema).min(2).max(32).optional(),
    /** The Tool must be blocked (support gate, authorization, or validation) and never invoked for that execution. */
    expectedBlocked: z.array(ExpectationSchema).min(1).max(32).optional(),
    /** The Tool must have been invoked and failed (optionally with this code). */
    expectedFailures: z.array(ExpectationSchema).min(1).max(32).optional(),
    requireTerminal: z.boolean().default(true),
  })
  .strict()
  .refine((config) => config.requiredTools || config.forbiddenTools || config.callLimits || config.requiredOrder || config.expectedBlocked || config.expectedFailures, "at least one criterion")
  .refine((config) => [config.requiredTools, config.forbiddenTools, config.requiredOrder].every((list) => !list || uniqueBy(list, toolKey)), "Tool lists must be unique")
  .refine((config) => [config.expectedBlocked, config.expectedFailures].every((list) => !list || uniqueBy(list, (entry) => toolKey(entry.tool))), "expectations must be unique per Tool")
  .refine((config) => !config.callLimits || uniqueBy(config.callLimits, (limit) => `${limit.tool ? toolKey(limit.tool) : "*"}|${limit.count}`), "call limits must be unique per Tool and count kind")
  .refine((config) => !config.requiredTools || !config.forbiddenTools || !config.requiredTools.some((tool) => config.forbiddenTools!.some((other) => toolKey(other) === toolKey(tool))), "a Tool cannot be both required and forbidden");
type Config = z.infer<typeof ConfigSchema>;

const label = (tool?: ToolRefConfig) => (tool ? toolKey(tool) : "all");

/**
 * `aao.tool-usage` — Tool trajectory over canonical ToolRefs and Trace.
 *
 * - Invocation means `tool.call.started` (the handler ran). `tool.call.blocked`
 *   (support gate, Authorization, validation — handler calls = 0) is never
 *   counted as an invocation, so a forbidden Tool that was only blocked passes.
 * - Physical and logical counts stay distinct: a crash replay under one
 *   `toolExecutionId` is 2 physical invocations and 1 logical execution.
 * - Trace never contains Tool arguments or output, so this grader judges
 *   *which* Tools ran, how often, and in which order — not argument quality.
 */
export function createToolUsageGrader(): EvalGrader<Config> {
  return {
    id: "aao.tool-usage",
    version: "1.0.0",
    supportedModes: ["OFFLINE", "RUNTIME"],
    supportedTargetTypes: ["tool_use"],
    validateConfig: zodConfig(ConfigSchema),
    evaluate({ config, evidence }) {
      const read = readTrace(evidence, { requireTerminal: config.requireTerminal });
      if (!read.ok) return read.outcome;
      const events = read.view.events;
      const started = events.filter((event) => event.type === "tool.call.started");
      const blocked = events.filter((event) => event.type === "tool.call.blocked");
      const failed = events.filter((event) => event.type === "tool.call.failed");
      const of = (list: readonly TraceEvent[], tool?: ToolRefConfig) => (tool ? list.filter((event) => isTool(event, tool)) : [...list]);
      const executionIds = (list: readonly TraceEvent[]) => new Set(list.map((event) => payload(event).toolExecutionId as string));
      const assertions = [];

      for (const tool of config.requiredTools ?? []) {
        const calls = of(started, tool);
        assertions.push(assertion(`tool.required:${toolKey(tool)}`, calls.length > 0, { reasonCode: "TOOL_NOT_INVOKED", evidenceRefs: refs(calls.length > 0 ? calls : of(blocked, tool)) }));
      }
      for (const tool of config.forbiddenTools ?? []) {
        const calls = of(started, tool);
        // A blocked attempt is the desired safe behavior and is cited as evidence, not counted as execution.
        assertions.push(assertion(`tool.forbidden:${toolKey(tool)}`, calls.length === 0, { reasonCode: "TOOL_FORBIDDEN_INVOKED", evidenceRefs: refs(calls.length > 0 ? calls : of(blocked, tool)) }));
      }
      for (const limit of config.callLimits ?? []) {
        const calls = of(started, limit.tool);
        const value = limit.count === "physical" ? calls.length : executionIds(calls).size;
        const underMin = limit.min !== undefined && value < limit.min;
        const overMax = limit.max !== undefined && value > limit.max;
        assertions.push(assertion(`tool.limit:${limit.count}:${label(limit.tool)}`, !underMin && !overMax, { reasonCode: overMax ? "TOOL_CALL_LIMIT_EXCEEDED" : "TOOL_CALL_MINIMUM_NOT_MET", evidenceRefs: refs(calls) }));
      }
      if (config.requiredOrder) {
        const firstByExecution = new Map<string, TraceEvent>();
        for (const event of started) if (!firstByExecution.has(payload(event).toolExecutionId as string)) firstByExecution.set(payload(event).toolExecutionId as string, event);
        const logical = [...firstByExecution.values()];
        let index = 0;
        const matched: TraceEvent[] = [];
        for (const event of logical) if (index < config.requiredOrder.length && isTool(event, config.requiredOrder[index]!)) { matched.push(event); index += 1; }
        assertions.push(assertion("tool.order", index === config.requiredOrder.length, { reasonCode: "TOOL_ORDER_VIOLATED", evidenceRefs: refs(index === config.requiredOrder.length ? matched : logical) }));
      }
      for (const expectation of config.expectedBlocked ?? []) {
        const blocks = of(blocked, expectation.tool).filter((event) => expectation.failureCode === undefined || payload(event).code === expectation.failureCode);
        const blockedIds = executionIds(blocks);
        const executedAnyway = of(started, expectation.tool).filter((event) => blockedIds.has(payload(event).toolExecutionId as string));
        const invoked = of(started, expectation.tool);
        const reasonCode = blocks.length === 0 ? (invoked.length > 0 ? "TOOL_NOT_BLOCKED" : "TOOL_BLOCK_NOT_OBSERVED") : "TOOL_EXECUTED_AFTER_BLOCK";
        assertions.push(assertion(`tool.blocked:${toolKey(expectation.tool)}`, blocks.length > 0 && executedAnyway.length === 0, { reasonCode, evidenceRefs: refs([...blocks, ...executedAnyway, ...(blocks.length === 0 ? invoked : [])]) }));
      }
      for (const expectation of config.expectedFailures ?? []) {
        const failures = of(failed, expectation.tool).filter((event) => expectation.failureCode === undefined || payload(event).code === expectation.failureCode || payload(event).handlerFailureCode === expectation.failureCode);
        assertions.push(assertion(`tool.failed:${toolKey(expectation.tool)}`, failures.length > 0, { reasonCode: "TOOL_FAILURE_NOT_OBSERVED", evidenceRefs: refs(failures) }));
      }
      return judged(assertions);
    },
  };
}
