import { expect } from "vitest";
import type { ModelPricingProfile, TraceEvent, TraceEventDraft } from "@aao/contracts";
import { createInMemoryTraceStore, createTraceRecorder } from "../src/index.js";

/**
 * Synthetic-but-valid traces for Metrics tests: each draft goes through the
 * real Trace recorder (identity, sequence, validation) with a scripted
 * clock, so timestamps are exact and every event is contract-valid.
 */
export const ID = { runId: "run.metrics", workflowId: "wf.metrics", workflowVersion: "1.0.0" } as const;
type Draft = DistributiveOmit<TraceEventDraft, "runId" | "workflowId" | "workflowVersion">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export const at = (seconds: number) => new Date(Date.UTC(2026, 9, 8, 12, 0, 0) + seconds * 1000).toISOString();

export async function traceOf(entries: Array<[number, Draft]>, identity: { runId: string; workflowId: string; workflowVersion: string } = ID): Promise<TraceEvent[]> {
  const times = entries.map(([seconds]) => at(seconds));
  let index = 0;
  const store = createInMemoryTraceStore();
  const recorder = createTraceRecorder({ store, clock: { now: () => times[index++]! } });
  for (const [, draft] of entries) await recorder.emit({ ...draft, ...identity } as TraceEventDraft);
  expect(recorder.health().issues).toEqual([]);
  return store.getRunTrace(identity.runId);
}

const run = { kind: "run" } as const;
const nodeSpan = (nodeId: string, step: number, attempt: number) => ({ kind: "node" as const, nodeId, step, attempt });

export const d = {
  runStarted: (entryNodeId = "a", policies: Array<{ nodeId: string; maxAttempts: number }> = []): Draft => ({ type: "run.started", span: run, key: {}, payload: { entryNodeId, initialStateRevision: 0, nodeCount: 3, reliabilityPolicies: policies } }),
  runCompleted: (steps: number, finalNodeId = "final", stateRevision = 0): Draft => ({ type: "run.completed", span: run, key: {}, payload: { finalNodeId, stateRevision, steps } }),
  runFailed: (code: string, category: "AUTHORIZATION" | "APPROVAL" | "EXECUTION" | "TRANSIENT_DEPENDENCY", steps: number): Draft => ({ type: "run.failed", span: run, key: {}, payload: { code, category, stateRevision: 0, steps } }),
  runCancelled: (steps: number): Draft => ({ type: "run.cancelled", span: run, key: {}, payload: { code: "RUN_CANCELLED", stateRevision: 0, steps } }),
  nodeStarted: (nodeId: string, step: number, attempt = 1, kind: "tool" | "deterministic" | "approval" | "model" | "final_output" = "deterministic", recoveryReplay = false): Draft => ({ type: "node.started", nodeId, span: nodeSpan(nodeId, step, attempt), key: { step, attempt, replay: recoveryReplay }, payload: { kind, step, attempt, maxAttempts: 3, stateRevision: 0, recoveryReplay } }),
  nodeCompleted: (nodeId: string, step: number, attemptCount = 1, kind: "tool" | "deterministic" | "approval" | "model" | "final_output" = "deterministic", outcomeSource: "executor" | "recovered" | "approval_resolution" = "executor"): Draft => ({ type: "node.completed", nodeId, span: nodeSpan(nodeId, step, attemptCount), key: { step }, payload: { kind, step, attemptCount, stateRevisionBefore: 0, stateRevisionAfter: 0, outcomeSource } }),
  nodeFailed: (nodeId: string, step: number, attemptCount: number, kind: "tool" | "approval", code: string, category: "AUTHORIZATION" | "APPROVAL" | "TRANSIENT_DEPENDENCY", executorCode?: string): Draft => ({ type: "node.failed", nodeId, span: nodeSpan(nodeId, step, attemptCount), key: { step }, payload: { kind, step, attemptCount, code, category, retryable: false, ...(executorCode ? { executorFailure: { namespace: "tool", code: executorCode } } : {}) } }),
  nodeWaiting: (nodeId: string, step: number, referenceId: string): Draft => ({ type: "node.waiting", nodeId, span: nodeSpan(nodeId, step, 1), key: { step }, payload: { kind: "approval", step, waitKind: "approval", referenceId } }),
  retryScheduled: (nodeId: string, step: number, failedAttempt: number): Draft => ({ type: "retry.scheduled", nodeId, span: nodeSpan(nodeId, step, failedAttempt), key: { step, failedAttempt }, payload: { step, failedAttempt, nextAttempt: failedAttempt + 1, maxAttempts: 3, category: "TRANSIENT_DEPENDENCY", causeCode: "TOOL_EXECUTION_FAILED", delayMs: 0 } }),
  retryExhausted: (nodeId: string, step: number, attempt: number): Draft => ({ type: "retry.exhausted", nodeId, span: nodeSpan(nodeId, step, attempt), key: { step }, payload: { step, attempt, maxAttempts: 3, category: "TRANSIENT_DEPENDENCY", causeCode: "TOOL_EXECUTION_FAILED" } }),
  checkpoint: (sequence: number): Draft => ({ type: "checkpoint.created", span: run, key: { checkpointSequence: sequence }, payload: { checkpointId: `checkpoint.${String(sequence).padStart(6, "0")}`, checkpointSequence: sequence, runStatus: "RUNNING", stateRevision: 0, step: 0, planFingerprint: "a".repeat(64) } }),
  approvalRequested: (nodeId: string, step: number, approvalId: string): Draft => ({ type: "approval.requested", nodeId, span: nodeSpan(nodeId, step, 1), parentSpan: run, key: { approvalId }, payload: { approvalId, step, requestedBy: { id: "user.alice", type: "user" }, requiredApproverRoleIds: ["manager"], permissionClasses: ["read_only"], allowSelfApproval: false, requestFingerprint: "b".repeat(64) } }),
  approvalResolved: (nodeId: string, approvalId: string, status: "approved" | "rejected", resolvedAt: string): Draft => ({ type: "approval.resolved", nodeId, span: run, key: { approvalId }, payload: { approvalId, status, resolvedBy: { id: "user.bob", type: "user" }, resolvedAt } }),
  toolStarted: (nodeId: string, step: number, attempt: number, toolExecutionId: string, recoveryReplay = false): Draft => ({ type: "tool.call.started", nodeId, span: { kind: "tool", toolExecutionId, attempt }, parentSpan: nodeSpan(nodeId, step, attempt), key: { step, attempt, replay: recoveryReplay }, payload: { toolRef: { id: "local.lookup", version: "1.0.0" }, toolExecutionId, attempt, permissionClasses: ["read_only"], access: { decision: "allow", principalId: "user.alice", agentCeilingApplied: false }, recoveryReplay } }),
  toolCompleted: (nodeId: string, step: number, attempt: number, toolExecutionId: string, recoveryReplay = false): Draft => ({ type: "tool.call.completed", nodeId, span: { kind: "tool", toolExecutionId, attempt }, parentSpan: nodeSpan(nodeId, step, attempt), key: { step, attempt, replay: recoveryReplay }, payload: { toolRef: { id: "local.lookup", version: "1.0.0" }, toolExecutionId, attempt, permissionClasses: ["read_only"], result: "success" } }),
  toolFailed: (nodeId: string, step: number, attempt: number, toolExecutionId: string): Draft => ({ type: "tool.call.failed", nodeId, span: { kind: "tool", toolExecutionId, attempt }, parentSpan: nodeSpan(nodeId, step, attempt), key: { step, attempt }, payload: { toolRef: { id: "local.lookup", version: "1.0.0" }, toolExecutionId, attempt, code: "TOOL_EXECUTION_FAILED", handlerFailureCode: "UPSTREAM_UNAVAILABLE", retryable: true, category: "TRANSIENT_DEPENDENCY" } }),
  toolBlocked: (nodeId: string, step: number, toolExecutionId: string): Draft => ({ type: "tool.call.blocked", nodeId, span: { kind: "tool", toolExecutionId, attempt: 1 }, parentSpan: nodeSpan(nodeId, step, 1), key: { step }, payload: { toolRef: { id: "local.lookup", version: "1.0.0" }, toolExecutionId, attempt: 1, code: "TOOL_AUTHORIZATION_DENIED", category: "AUTHORIZATION", permissionClasses: ["read_only"], access: { decision: "deny", reasonCode: "PERMISSION_NOT_GRANTED" } } }),
  modelStarted: (nodeId: string, step: number, invocationId: string, identity?: { provider: string; model: string; revision?: string }): Draft => ({ type: "model.call.started", nodeId, span: { kind: "model", invocationId, attempt: 1 }, parentSpan: nodeSpan(nodeId, step, 1), key: { step }, payload: { invocationId, attempt: 1, modelPolicyRef: "policy.default", modelBindingId: "binding.default", outputKind: "text", requiredCapabilityIds: [], ...(identity ? { modelIdentity: identity } : {}), recoveryReplay: false } }),
  modelCompleted: (nodeId: string, step: number, invocationId: string, usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }): Draft => ({ type: "model.call.completed", nodeId, span: { kind: "model", invocationId, attempt: 1 }, parentSpan: nodeSpan(nodeId, step, 1), key: { step }, payload: { invocationId, attempt: 1, modelBindingId: "binding.default", outputKind: "text", finishReason: "stop", ...(usage ? { usage } : {}) } }),
  modelFailed: (nodeId: string, step: number, invocationId: string): Draft => ({ type: "model.call.failed", nodeId, span: { kind: "model", invocationId, attempt: 1 }, parentSpan: nodeSpan(nodeId, step, 1), key: { step }, payload: { invocationId, attempt: 1, modelBindingId: "binding.default", code: "MODEL_PROVIDER_ERROR", adapterReason: "provider_error" } }),
  stateUpdated: (nodeId: string, step: number, revisionAfter: number): Draft => ({ type: "state.updated", nodeId, span: nodeSpan(nodeId, step, 1), key: { step }, payload: { step, revisionBefore: revisionAfter - 1, revisionAfter, changedKeys: ["result"] } }),
  recoveryStarted: (sequence: number): Draft => ({ type: "recovery.started", span: run, key: { checkpointSequence: sequence }, payload: { checkpointId: `checkpoint.${String(sequence).padStart(6, "0")}`, checkpointSequence: sequence, runStatus: "RUNNING", stateRevision: 0 } }),
};

/** Explicit trusted pricing for tests. Example identities only — no real provider prices. */
export const examplePricing: ModelPricingProfile = { schemaVersion: 1, profileId: "pricing.example", profileVersion: "2026-01", provider: "example", model: "example-model", currency: "USD", inputNanosPerMillionTokens: 3_000_000_000, outputNanosPerMillionTokens: 15_000_000_000 };
