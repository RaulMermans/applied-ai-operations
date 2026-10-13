import { z } from "zod";
import { TRACE_TERMINAL_EVENT_TYPES, type TraceEvent } from "@aao/contracts";
import { checkTraceEvent, compareTraceWithExecution, validateTrace } from "@aao/observability";
import { evidenceRefs } from "../evidence.js";
import { assertion, gradeError, judged, zodConfig, type EvalGrader } from "../grader.js";

const ConfigSchema = z
  .object({
    /** The Trace must contain exactly one terminal Run event. Default true. */
    requireTerminal: z.boolean().default(true),
    /** Passed to `validateTrace` as the Run's authoritative status (terminal-event consistency). */
    expectedRunStatus: z.enum(["COMPLETED", "FAILED", "CANCELLED", "WAITING_FOR_APPROVAL"]).optional(),
    /** Also compare against Runtime execution evidence with `compareTraceWithExecution` (requires execution evidence). */
    compareWithExecution: z.boolean().default(false),
  })
  .strict()
  .refine((config) => !(config.requireTerminal && config.expectedRunStatus === "WAITING_FOR_APPROVAL"), "a waiting Run has no terminal event");
type Config = z.infer<typeof ConfigSchema>;

/**
 * `aao.trace-contract` — is the Trace valid, complete enough, and
 * lifecycle-coherent? It reuses the canonical `validateTrace` /
 * `compareTraceWithExecution` (no second validator). Here Trace validity *is*
 * the criterion, so an invalid Trace is `failed` with the diagnostic code;
 * an absent Trace (or absent execution evidence when comparison is
 * required) is `error`.
 */
export function createTraceContractGrader(): EvalGrader<Config> {
  return {
    id: "aao.trace-contract",
    version: "1.0.0",
    supportedModes: ["OFFLINE", "RUNTIME"],
    supportedTargetTypes: ["run", "trajectory"],
    validateConfig: zodConfig(ConfigSchema),
    evaluate({ config, evidence }) {
      const trace = evidence.trace;
      if (trace === undefined || trace.length === 0) return gradeError("EVAL_EVIDENCE_MISSING");
      if (config.compareWithExecution && evidence.execution === undefined) return gradeError("EVAL_EVIDENCE_MISSING");
      const valid = trace.flatMap((raw) => { const checked = checkTraceEvent(raw); return checked.ok ? [checked.event] : []; });
      const runId = valid[0]?.runId ?? evidence.runId ?? "unidentified";
      const issueRefs = (issues: ReadonlyArray<{ sequence?: number }>) => issues.flatMap((issue) => (issue.sequence !== undefined ? [evidenceRefs.traceEvent(runId, issue.sequence)] : []));

      const validation = validateTrace(trace, config.expectedRunStatus ? { runStatus: config.expectedRunStatus } : {});
      const assertions = [assertion("trace.valid", validation.valid, { reasonCode: validation.issues[0]?.code, evidenceRefs: validation.valid ? [] : issueRefs(validation.issues) })];
      if (config.requireTerminal) {
        const terminals: TraceEvent[] = valid.filter((event) => TRACE_TERMINAL_EVENT_TYPES.includes(event.type));
        assertions.push(assertion("trace.terminal", terminals.length === 1, { reasonCode: "TRACE_TERMINAL_EVENT_MISSING", evidenceRefs: terminals.map((event) => evidenceRefs.traceEvent(event.runId, event.sequence)) }));
      }
      if (config.compareWithExecution) {
        const comparison = compareTraceWithExecution(trace, evidence.execution as unknown as Parameters<typeof compareTraceWithExecution>[1]);
        assertions.push(assertion("trace.matches-execution", comparison.valid, { reasonCode: comparison.issues[0]?.code, evidenceRefs: [...issueRefs(comparison.issues), evidenceRefs.stateRevision(evidence.execution!.run.runId, evidence.execution!.state.revision)] }));
      }
      return judged(assertions);
    },
  };
}
