import type { RuntimeExecutionState } from "@aao/framework";
import { ana, approvedUpdateWorkflow, bindSession, calls, createGoldenPathApp, resetGoldenPathCounters } from "./golden-path.js";

/**
 * Framework `createAAO` Approvals are process-local. Serializing a waiting Run
 * and continuing it on a fresh application instance fails closed because the
 * Approval record is gone. Durable Approval storage is a documented Local V1
 * limitation, not a missing test.
 */
export async function demonstrateFrameworkApprovalRestartLimitation() {
  resetGoldenPathCounters();
  const first = createGoldenPathApp();
  const prepared = first.prepareWorkflow(approvedUpdateWorkflow);
  const runId = "run.restart-limitation";
  bindSession(runId, ana);
  const waiting = await prepared.execute({
    runId,
    initialState: { runId, revision: 0, values: { proposal: { account: "acme", change: "restart test" } } },
  });
  if (waiting.execution?.run.status !== "WAITING_FOR_APPROVAL") {
    throw new Error(`expected WAITING_FOR_APPROVAL, got ${waiting.execution?.run.status}`);
  }
  const snapshot = JSON.parse(JSON.stringify(waiting.execution)) as RuntimeExecutionState;
  const restarted = createGoldenPathApp();
  const continued = await restarted.prepareWorkflow(approvedUpdateWorkflow).continue(snapshot);
  return {
    waitingStatus: waiting.execution.run.status,
    restartedOk: continued.ok,
    restartedFailure: continued.ok ? undefined : continued.failure.code,
    draftCalls: calls.draft,
  };
}
