import { z } from "zod";
import { EvalReasonCodeSchema, FailureCategorySchema, type RunStatus } from "@aao/contracts";
import { evidenceRefs } from "../evidence.js";
import { assertion, gradeError, judged, zodConfig, type EvalGrader } from "../grader.js";
import { payload, readTrace, ref, runStatusFromTrace } from "../trace-view.js";

const JudgeableStatusSchema = z.enum(["COMPLETED", "FAILED", "CANCELLED", "WAITING_FOR_APPROVAL"]);

const ConfigSchema = z
  .object({
    expectedStatus: JudgeableStatusSchema.optional(),
    forbiddenStatuses: z.array(JudgeableStatusSchema).min(1).max(4).optional(),
    /** The terminal `run.failed` code / category (from Trace). */
    expectedFailureCode: EvalReasonCodeSchema.optional(),
    expectedFailureCategory: FailureCategorySchema.optional(),
  })
  .strict()
  .refine((config) => config.expectedStatus !== undefined || config.forbiddenStatuses !== undefined, "at least one status criterion")
  .refine((config) => !config.forbiddenStatuses || new Set(config.forbiddenStatuses).size === config.forbiddenStatuses.length, "forbidden statuses must be unique")
  .refine((config) => (config.expectedFailureCode === undefined && config.expectedFailureCategory === undefined) || config.expectedStatus === "FAILED", "failure expectations require expectedStatus FAILED");
type Config = z.infer<typeof ConfigSchema>;

/**
 * `aao.run-outcome` — deterministic Run status assertions. Runtime
 * execution evidence is the lifecycle truth when present; the Trace's
 * terminal event is used otherwise, and a disagreement between them is
 * untrustworthy evidence (`error`). A Run that has not reached a terminal
 * or approval-wait boundary cannot be judged (`error`).
 */
export function createRunOutcomeGrader(): EvalGrader<Config> {
  return {
    id: "aao.run-outcome",
    version: "1.0.0",
    supportedModes: ["OFFLINE", "RUNTIME"],
    supportedTargetTypes: ["run"],
    validateConfig: zodConfig(ConfigSchema),
    evaluate({ config, evidence }) {
      const needsTrace = config.expectedFailureCode !== undefined || config.expectedFailureCategory !== undefined;
      if (evidence.trace === undefined && (evidence.execution === undefined || needsTrace)) return gradeError("EVAL_EVIDENCE_MISSING");
      let traceStatus: RunStatus | undefined;
      let terminalRefs: string[] = [];
      let failure: Record<string, unknown> | undefined;
      if (evidence.trace !== undefined) {
        const read = readTrace(evidence, { requireTerminal: false });
        if (!read.ok) return read.outcome;
        traceStatus = runStatusFromTrace(read.view.events);
        if (read.view.terminal) {
          terminalRefs = [ref(read.view.terminal)];
          if (read.view.terminal.type === "run.failed") failure = payload(read.view.terminal);
        }
      }
      const executionStatus = evidence.execution?.run.status;
      if (executionStatus !== undefined && traceStatus !== undefined && executionStatus !== traceStatus) return gradeError("EVAL_EVIDENCE_INVALID");
      const status = (executionStatus ?? traceStatus)!;
      if (!["COMPLETED", "FAILED", "CANCELLED", "WAITING_FOR_APPROVAL"].includes(status)) return gradeError("EVAL_REQUIRED_EVIDENCE_INCOMPLETE");
      const statusRefs = [...terminalRefs, ...(evidence.execution ? [evidenceRefs.stateRevision(evidence.execution.run.runId, evidence.execution.state.revision)] : [])];

      const assertions = [];
      if (config.expectedStatus) assertions.push(assertion("run.status", status === config.expectedStatus, { reasonCode: "RUN_STATUS_MISMATCH", evidenceRefs: statusRefs }));
      if (config.forbiddenStatuses) assertions.push(assertion("run.status-not-forbidden", !config.forbiddenStatuses.includes(status as z.infer<typeof JudgeableStatusSchema>), { reasonCode: "RUN_STATUS_FORBIDDEN", evidenceRefs: statusRefs }));
      if (config.expectedFailureCode) assertions.push(assertion("run.failure-code", failure?.code === config.expectedFailureCode, { reasonCode: "RUN_FAILURE_CODE_MISMATCH", evidenceRefs: terminalRefs }));
      if (config.expectedFailureCategory) assertions.push(assertion("run.failure-category", failure?.category === config.expectedFailureCategory, { reasonCode: "RUN_FAILURE_CATEGORY_MISMATCH", evidenceRefs: terminalRefs }));
      return judged(assertions);
    },
  };
}
