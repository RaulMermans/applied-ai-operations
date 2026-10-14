import type { EvalGrader } from "../grader.js";
import { createApprovalComplianceGrader } from "./approval-compliance.js";
import { createAuthorizationComplianceGrader } from "./authorization-compliance.js";
import { createMetricsThresholdGrader } from "./metrics-threshold.js";
import { createModelCallGrader } from "./model-call.js";
import { createRetryBehaviorGrader } from "./retry-behavior.js";
import { createRunOutcomeGrader } from "./run-outcome.js";
import { createStateAssertionGrader } from "./state-assertion.js";
import { createToolUsageGrader } from "./tool-usage.js";
import { createTraceContractGrader } from "./trace-contract.js";
import { createTrajectoryGrader } from "./trajectory.js";

export { createApprovalComplianceGrader, createAuthorizationComplianceGrader, createMetricsThresholdGrader, createModelCallGrader, createRetryBehaviorGrader, createRunOutcomeGrader, createStateAssertionGrader, createToolUsageGrader, createTraceContractGrader, createTrajectoryGrader };
export { createModelJudgeGrader, MODEL_JUDGE_LIMITS, type ModelJudgePort, type ModelJudgeRequest, type ModelJudgeResult } from "./model-judge.js";

/**
 * The built-in deterministic graders, each addressing a real AAO failure
 * class. The default Evaluation Runtime needs no model: the model judge is
 * registered only when a host explicitly supplies a judge port.
 */
export function deterministicGraders(): EvalGrader[] {
  return [
    createTraceContractGrader(),
    createRunOutcomeGrader(),
    createTrajectoryGrader(),
    createToolUsageGrader(),
    createApprovalComplianceGrader(),
    createAuthorizationComplianceGrader(),
    createRetryBehaviorGrader(),
    createStateAssertionGrader(),
    createMetricsThresholdGrader(),
    createModelCallGrader(),
  ] as EvalGrader[];
}
