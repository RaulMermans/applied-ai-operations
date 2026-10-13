import type { TraceEvent, TraceEventDraft } from "@aao/contracts";
import { createInMemoryTraceStore, createTraceRecorder } from "@aao/observability";

/**
 * Synthetic-but-contract-valid Trace evidence. Every draft goes through the
 * real Trace recorder (identity, sequence, schema validation) with a
 * scripted clock, so negative fixtures (forbidden Tool, bypass, retry after
 * denial) are valid canonical Traces of *undesired behavior* — exactly what
 * a grader must judge as `failed`, not as corrupt evidence.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type Draft = DistributiveOmit<TraceEventDraft, "runId" | "workflowId" | "workflowVersion">;
export interface TraceIdentity { runId: string; workflowId: string; workflowVersion: string }

export const at = (seconds: number) => new Date(Date.UTC(2026, 9, 8, 12, 0, 0) + seconds * 1000).toISOString();

export async function traceOf(identity: TraceIdentity, entries: Array<[number, Draft]>): Promise<TraceEvent[]> {
  const times = entries.map(([seconds]) => at(seconds));
  let index = 0;
  const store = createInMemoryTraceStore();
  const recorder = createTraceRecorder({ store, clock: { now: () => times[index++]! } });
  for (const [, draft] of entries) await recorder.emit({ ...draft, ...identity } as TraceEventDraft);
  const issues = recorder.health().issues;
  if (issues.length > 0) throw new Error(`synthetic trace rejected: ${JSON.stringify(issues)}`);
  return store.getRunTrace(identity.runId);
}

type Kind = "tool" | "deterministic" | "approval" | "model" | "final_output";
type Category = "AUTHORIZATION" | "APPROVAL" | "EXECUTION" | "TRANSIENT_DEPENDENCY";
const run = { kind: "run" } as const;
const nodeSpan = (nodeId: string, step: number, attempt: number) => ({ kind: "node" as const, nodeId, step, attempt });
export const LOOKUP = { id: "local.lookup", version: "1.0.0" } as const;
export const SEND_EMAIL = { id: "external.send-email", version: "1.0.0" } as const;

export const d = {
  runStarted: (entryNodeId: string, nodeCount = 4, policies: Array<{ nodeId: string; maxAttempts: number }> = []): Draft => ({ type: "run.started", span: run, key: {}, payload: { entryNodeId, initialStateRevision: 0, nodeCount, reliabilityPolicies: policies } }),
  runCompleted: (steps: number, stateRevision: number, finalNodeId = "final"): Draft => ({ type: "run.completed", span: run, key: {}, payload: { finalNodeId, stateRevision, steps } }),
  runFailed: (code: string, category: Category, steps: number, nodeId?: string): Draft => ({ type: "run.failed", span: run, key: {}, payload: { code, category, ...(nodeId ? { nodeId } : {}), stateRevision: 0, steps } }),
  nodeStarted: (nodeId: string, step: number, kind: Kind, attempt = 1, recoveryReplay = false, maxAttempts = 1): Draft => ({ type: "node.started", nodeId, span: nodeSpan(nodeId, step, attempt), key: { step, attempt, replay: recoveryReplay }, payload: { kind, step, attempt, maxAttempts, stateRevision: 0, recoveryReplay } }),
  nodeCompleted: (nodeId: string, step: number, kind: Kind, attemptCount = 1, before = 0, after = 0): Draft => ({ type: "node.completed", nodeId, span: nodeSpan(nodeId, step, attemptCount), key: { step }, payload: { kind, step, attemptCount, stateRevisionBefore: before, stateRevisionAfter: after, outcomeSource: "executor" } }),
  nodeFailed: (nodeId: string, step: number, kind: Kind, attemptCount: number, code: string, category: Category): Draft => ({ type: "node.failed", nodeId, span: nodeSpan(nodeId, step, attemptCount), key: { step }, payload: { kind, step, attemptCount, code, category, retryable: false } }),
  nodeWaiting: (nodeId: string, step: number, referenceId: string): Draft => ({ type: "node.waiting", nodeId, span: nodeSpan(nodeId, step, 1), key: { step }, payload: { kind: "approval", step, waitKind: "approval", referenceId } }),
  route: (sourceNodeId: string, targetNodeId: string): Draft => ({ type: "route.selected", span: run, key: { sourceNodeId }, payload: { sourceNodeId, targetNodeId, routeType: "unconditional" } }),
  stateUpdated: (nodeId: string, step: number, revisionAfter: number, changedKeys: string[]): Draft => ({ type: "state.updated", nodeId, span: nodeSpan(nodeId, step, 1), key: { step }, payload: { step, revisionBefore: revisionAfter - 1, revisionAfter, changedKeys } }),
  retryScheduled: (nodeId: string, step: number, failedAttempt: number, category: Category, causeCode: string, maxAttempts = 3): Draft => ({ type: "retry.scheduled", nodeId, span: nodeSpan(nodeId, step, failedAttempt), key: { step, failedAttempt }, payload: { step, failedAttempt, nextAttempt: failedAttempt + 1, maxAttempts, category, causeCode, delayMs: 0 } }),
  approvalRequested: (nodeId: string, step: number, approvalId: string): Draft => ({ type: "approval.requested", nodeId, span: nodeSpan(nodeId, step, 1), parentSpan: run, key: { approvalId }, payload: { approvalId, step, requestedBy: { id: "user.alice", type: "user" }, requiredApproverRoleIds: ["manager"], permissionClasses: ["read_only"], allowSelfApproval: false, requestFingerprint: "b".repeat(64) } }),
  approvalResolved: (nodeId: string, approvalId: string, status: "approved" | "rejected", resolvedAt: string): Draft => ({ type: "approval.resolved", nodeId, span: run, key: { approvalId }, payload: { approvalId, status, resolvedBy: { id: "user.bob", type: "user" }, resolvedAt } }),
  toolStarted: (nodeId: string, step: number, toolExecutionId: string, tool: { id: string; version: string } = LOOKUP, attempt = 1, recoveryReplay = false, permission: "read_only" | "write_draft" = "read_only"): Draft => ({ type: "tool.call.started", nodeId, span: { kind: "tool", toolExecutionId, attempt }, parentSpan: nodeSpan(nodeId, step, attempt), key: { step, attempt, replay: recoveryReplay }, payload: { toolRef: tool, toolExecutionId, attempt, permissionClasses: [permission], access: { decision: "allow", principalId: "user.alice", agentCeilingApplied: false }, recoveryReplay } }),
  toolCompleted: (nodeId: string, step: number, toolExecutionId: string, tool: { id: string; version: string } = LOOKUP, attempt = 1, recoveryReplay = false, permission: "read_only" | "write_draft" = "read_only"): Draft => ({ type: "tool.call.completed", nodeId, span: { kind: "tool", toolExecutionId, attempt }, parentSpan: nodeSpan(nodeId, step, attempt), key: { step, attempt, replay: recoveryReplay }, payload: { toolRef: tool, toolExecutionId, attempt, permissionClasses: [permission], result: "success" } }),
  toolFailed: (nodeId: string, step: number, toolExecutionId: string, attempt: number): Draft => ({ type: "tool.call.failed", nodeId, span: { kind: "tool", toolExecutionId, attempt }, parentSpan: nodeSpan(nodeId, step, attempt), key: { step, attempt }, payload: { toolRef: LOOKUP, toolExecutionId, attempt, code: "TOOL_EXECUTION_FAILED", handlerFailureCode: "UPSTREAM_UNAVAILABLE", retryable: true, category: "TRANSIENT_DEPENDENCY" } }),
  toolBlocked: (nodeId: string, step: number, toolExecutionId: string, attempt = 1): Draft => ({ type: "tool.call.blocked", nodeId, span: { kind: "tool", toolExecutionId, attempt }, parentSpan: nodeSpan(nodeId, step, attempt), key: { step, attempt }, payload: { toolRef: LOOKUP, toolExecutionId, attempt, code: "TOOL_AUTHORIZATION_DENIED", category: "AUTHORIZATION", permissionClasses: ["read_only"], access: { decision: "deny", reasonCode: "PERMISSION_NOT_GRANTED" } } }),
  modelStarted: (nodeId: string, step: number, invocationId: string, binding: string, identity: { provider: string; model: string }): Draft => ({ type: "model.call.started", nodeId, span: { kind: "model", invocationId, attempt: 1 }, parentSpan: nodeSpan(nodeId, step, 1), key: { step }, payload: { invocationId, attempt: 1, modelPolicyRef: "policy.default", modelBindingId: binding, outputKind: "text", requiredCapabilityIds: [], modelIdentity: identity, recoveryReplay: false } }),
  modelCompleted: (nodeId: string, step: number, invocationId: string, binding: string, identity: { provider: string; model: string }, usage?: { inputTokens: number; outputTokens: number; totalTokens: number }): Draft => ({ type: "model.call.completed", nodeId, span: { kind: "model", invocationId, attempt: 1 }, parentSpan: nodeSpan(nodeId, step, 1), key: { step }, payload: { invocationId, attempt: 1, modelBindingId: binding, outputKind: "text", finishReason: "stop", ...(usage ? { usage } : {}), modelIdentity: identity } }),
  checkpoint: (sequence: number, step: number): Draft => ({ type: "checkpoint.created", span: run, key: { checkpointSequence: sequence }, payload: { checkpointId: `checkpoint.${String(sequence).padStart(6, "0")}`, checkpointSequence: sequence, runStatus: "RUNNING", stateRevision: 0, step, planFingerprint: "a".repeat(64) } }),
  failureDetected: (code: string): Draft => ({ type: "failure.detected", span: run, key: { code }, payload: { source: "durability", code } }),
  recoveryStarted: (sequence: number): Draft => ({ type: "recovery.started", span: run, key: { checkpointSequence: sequence }, payload: { checkpointId: `checkpoint.${String(sequence).padStart(6, "0")}`, checkpointSequence: sequence, runStatus: "RUNNING", stateRevision: 0 } }),
  recoveryReplayed: (operationId: string, step: number, attempt: number): Draft => ({ type: "recovery.replayed", span: run, key: { operationId }, payload: { operationId, step, attempt, recoveryReplayCount: 1 } }),
  recoveryCompleted: (from: number, to: number): Draft => ({ type: "recovery.completed", span: run, key: { from }, payload: { fromCheckpointSequence: from, toCheckpointSequence: to } }),
};
