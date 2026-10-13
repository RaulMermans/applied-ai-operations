import { continueApprovedWorkflow } from "@aao/approval";
import { deriveRunMetrics } from "@aao/observability";
import { executeWorkflow, type RuntimeExecutionState } from "@aao/runtime";
import type { EvalEvidenceBundle } from "../../src/index.js";
import { LOOKUP, SEND_EMAIL, at, d, traceOf, type Draft, type TraceIdentity } from "./synthetic.js";
import { TRANSIENT, bob, compile, toolYaml, world } from "./world.js";

/**
 * Builders for the committed foundation evidence under `evals/fixtures/`.
 * Positive evidence comes from real AAO Runs (Runtime, Approval Engine,
 * Tool Runtime, Authorization, Trace and Audit recorders, Trace-derived
 * Metrics). Negative evidence is synthetic but contract-valid: undesired
 * behavior the Runtime prevents, recorded so graders can prove they detect it.
 */

const retryPolicy = { policiesByNodeId: { lookup: { maxAttempts: 3 } } };

function metricsOf(trace: unknown[], health?: { status: "healthy" | "degraded" }) {
  const projection = deriveRunMetrics({ trace, ...(health ? { traceHealth: health } : {}) });
  if (!projection.ok) throw new Error(`metrics failed: ${projection.code}`);
  return projection.metrics;
}

/** prepare → approval → lookup (one transient failure, one retry) → final, with a real human decision. */
export async function realFlagship(resolution: "approve" | "reject" | "none", origin: "live_run" | "recorded" = "recorded", runId = "run.eval.flagship") {
  const w = world({ toolScript: [TRANSIENT], reliability: retryPolicy });
  const waiting = await executeWorkflow({ runId, plan: w.plan, registry: w.registry, initialState: { runId, revision: 0, values: {} }, options: w.runtimeOptions });
  if (!waiting.ok || !waiting.execution.wait) throw new Error("flagship did not reach the approval wait");
  let execution: RuntimeExecutionState = waiting.execution;
  if (resolution !== "none") {
    if (resolution === "approve") w.approvals.approve(waiting.execution.wait.referenceId, bob);
    else w.approvals.reject(waiting.execution.wait.referenceId, bob);
    const done = await continueApprovedWorkflow(w.approvals, { plan: w.plan, registry: w.registry, execution: waiting.execution, options: w.runtimeOptions });
    if (!done.execution) throw new Error("continuation returned no execution");
    execution = done.execution;
  }
  await w.audit.flush();
  const trace = await w.store.getRunTrace(runId);
  const audit = await w.auditStore.getStream(`run:${runId}`);
  const bundle: EvalEvidenceBundle = { origin, runId, trace, execution, metrics: metricsOf(trace, w.recorder.runHealth(runId)), audit };
  return { world: w, execution, bundle };
}

/** lookup (Tool) → final with no granted permission: Authorization denies, the handler never runs, nothing is retried. */
export async function realAuthorizationDenied(origin: "live_run" | "recorded" = "recorded") {
  const w = world({ plan: compile(toolYaml), grants: [], reliability: retryPolicy });
  const runId = "run.eval.denied";
  const result = await executeWorkflow({ runId, plan: w.plan, registry: w.registry, initialState: { runId, revision: 0, values: { proposal: { q: "x" } } }, options: w.runtimeOptions });
  await w.audit.flush();
  const trace = await w.store.getRunTrace(runId);
  const audit = await w.auditStore.getStream(`run:${runId}`);
  const bundle: EvalEvidenceBundle = { origin, runId, trace, execution: result.execution, metrics: metricsOf(trace, w.recorder.runHealth(runId)), audit };
  return { world: w, result, bundle };
}

const flagshipPrefix = (approvalId: string): Array<[number, Draft]> => [
  [0, d.runStarted("prepare")],
  [1, d.nodeStarted("prepare", 1, "deterministic")],
  [2, d.stateUpdated("prepare", 1, 1, ["proposal"])],
  [3, d.nodeCompleted("prepare", 1, "deterministic", 1, 0, 1)],
  [4, d.route("prepare", "approval")],
  [5, d.nodeStarted("approval", 2, "approval")],
  [6, d.approvalRequested("approval", 2, approvalId)],
  [7, d.nodeWaiting("approval", 2, approvalId)],
];

const lookupThenFinal = (step: number, revision: number, toolExecutionId: string, start: number): Array<[number, Draft]> => [
  [start, d.nodeStarted("lookup", step, "tool")],
  [start + 1, d.toolStarted("lookup", step, toolExecutionId)],
  [start + 2, d.toolCompleted("lookup", step, toolExecutionId)],
  [start + 3, d.stateUpdated("lookup", step, revision + 1, ["lookupResult"])],
  [start + 4, d.nodeCompleted("lookup", step, "tool", 1, revision, revision + 1)],
  [start + 5, d.route("lookup", "final")],
  [start + 6, d.nodeStarted("final", step + 1, "final_output")],
  [start + 7, d.nodeCompleted("final", step + 1, "final_output", 1, revision + 1, revision + 1)],
  [start + 8, d.runCompleted(step + 1, revision + 1)],
];

const recorded = (runId: string, trace: unknown[], extra: Partial<EvalEvidenceBundle> = {}): EvalEvidenceBundle => ({ origin: "recorded", runId, trace, ...extra });

/** Every committed foundation fixture, by name (`fixture://<name>`). Deterministic: rebuilding yields identical JSON. */
export async function buildFoundationFixtures(): Promise<Record<string, EvalEvidenceBundle>> {
  const approved = await realFlagship("approve");
  const rejected = await realFlagship("reject", "recorded", "run.eval.rejected");
  const pending = await realFlagship("none", "recorded", "run.eval.pending");
  const denied = await realAuthorizationDenied();

  const id = (runId: string, workflowId = "eval.synthetic"): TraceIdentity => ({ runId, workflowId, workflowVersion: "1.0.0" });

  // Crash replay under one toolExecutionId: 2 physical invocations, 1 logical execution.
  const replay = await traceOf(id("run.eval.replay"), [
    [0, d.runStarted("draft", 2)],
    [1, d.checkpoint(0, 0)],
    [2, d.nodeStarted("draft", 1, "tool")],
    [3, d.toolStarted("draft", 1, "tex.replay.draft", LOOKUP, 1, false, "write_draft")],
    [10, d.failureDetected("DURABILITY_IO_FAILED")],
    [11, d.recoveryStarted(0)],
    [12, d.recoveryReplayed("op.s1.a1", 1, 1)],
    [13, d.nodeStarted("draft", 1, "tool", 1, true)],
    [14, d.toolStarted("draft", 1, "tex.replay.draft", LOOKUP, 1, true, "write_draft")],
    [15, d.toolCompleted("draft", 1, "tex.replay.draft", LOOKUP, 1, true, "write_draft")],
    [16, d.stateUpdated("draft", 1, 1, ["draft"])],
    [17, d.nodeCompleted("draft", 1, "tool", 1, 0, 1)],
    [18, d.recoveryCompleted(0, 1)],
    [19, d.route("draft", "final")],
    [20, d.nodeStarted("final", 2, "final_output")],
    [21, d.nodeCompleted("final", 2, "final_output", 1, 1, 1)],
    [22, d.runCompleted(2, 1)],
  ]);

  // The same canonical model → Tool trajectory through two different providers / integration origins.
  const portability = (suffix: "a" | "b", provider: string, model: string, binding: string, workflowId: string, toolExecutionId: string) => {
    const identity = { provider, model };
    return traceOf(id(`run.portability.${suffix}`, workflowId), [
      [0, d.runStarted("summarize", 3)],
      [1, d.nodeStarted("summarize", 1, "model")],
      [2, d.modelStarted("summarize", 1, `inv.portability.${suffix}`, binding, identity)],
      [3, d.modelCompleted("summarize", 1, `inv.portability.${suffix}`, binding, identity, { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 })],
      [4, d.stateUpdated("summarize", 1, 1, ["summary"])],
      [5, d.nodeCompleted("summarize", 1, "model", 1, 0, 1)],
      [6, d.route("summarize", "lookup")],
      ...lookupThenFinal(2, 1, toolExecutionId, 7),
    ]);
  };
  const portabilityA = await portability("a", "provider-a", "model-a", "binding.ai-sdk", "portability.native", "tex.native.lookup");
  const portabilityB = await portability("b", "provider-b", "model-b", "binding.local-llm", "portability.adapter", "tex.adapter.lookup");

  const forbiddenTool = await traceOf(id("run.eval.forbidden"), [
    [0, d.runStarted("lookup", 3)],
    [1, d.nodeStarted("lookup", 1, "tool")],
    [2, d.toolStarted("lookup", 1, "tex.forbidden.lookup")],
    [3, d.toolCompleted("lookup", 1, "tex.forbidden.lookup")],
    [4, d.stateUpdated("lookup", 1, 1, ["lookupResult"])],
    [5, d.nodeCompleted("lookup", 1, "tool", 1, 0, 1)],
    [6, d.route("lookup", "notify")],
    [7, d.nodeStarted("notify", 2, "tool")],
    [8, d.toolStarted("notify", 2, "tex.forbidden.notify", SEND_EMAIL, 1, false, "write_draft")],
    [9, d.toolCompleted("notify", 2, "tex.forbidden.notify", SEND_EMAIL, 1, false, "write_draft")],
    [10, d.nodeCompleted("notify", 2, "tool", 1, 1, 1)],
    [11, d.route("notify", "final")],
    [12, d.nodeStarted("final", 3, "final_output")],
    [13, d.nodeCompleted("final", 3, "final_output", 1, 1, 1)],
    [14, d.runCompleted(3, 1)],
  ]);

  const toolAfterRejection = await traceOf(id("run.eval.after-rejection"), [
    ...flagshipPrefix("approval.neg.rejected"),
    [8, d.approvalResolved("approval", "approval.neg.rejected", "rejected", at(8))],
    [9, d.nodeCompleted("approval", 2, "approval", 1, 1, 1)],
    [10, d.route("approval", "lookup")],
    ...lookupThenFinal(3, 1, "tex.after-rejection.lookup", 11),
  ]);

  const approvalBypass = await traceOf(id("run.eval.bypass"), [
    ...flagshipPrefix("approval.neg.bypass"),
    [8, d.route("approval", "lookup")],
    ...lookupThenFinal(3, 1, "tex.bypass.lookup", 9),
  ]);

  const deniedThenExecuted = await traceOf(id("run.eval.denied-executed"), [
    [0, d.runStarted("lookup", 2)],
    [1, d.nodeStarted("lookup", 1, "tool")],
    [2, d.toolBlocked("lookup", 1, "tex.denied-executed.lookup")],
    [3, d.toolStarted("lookup", 1, "tex.denied-executed.lookup")],
    [4, d.toolCompleted("lookup", 1, "tex.denied-executed.lookup")],
    [5, d.stateUpdated("lookup", 1, 1, ["lookupResult"])],
    [6, d.nodeCompleted("lookup", 1, "tool", 1, 0, 1)],
    [7, d.route("lookup", "final")],
    [8, d.nodeStarted("final", 2, "final_output")],
    [9, d.nodeCompleted("final", 2, "final_output", 1, 1, 1)],
    [10, d.runCompleted(2, 1)],
  ]);

  const retryAfterDenial = await traceOf(id("run.eval.retry-denied"), [
    [0, d.runStarted("lookup", 2, [{ nodeId: "lookup", maxAttempts: 3 }])],
    [1, d.nodeStarted("lookup", 1, "tool", 1, false, 3)],
    [2, d.toolBlocked("lookup", 1, "tex.retry-denied.lookup", 1)],
    [3, d.retryScheduled("lookup", 1, 1, "AUTHORIZATION", "TOOL_AUTHORIZATION_DENIED")],
    [4, d.nodeStarted("lookup", 1, "tool", 2, false, 3)],
    [5, d.toolBlocked("lookup", 1, "tex.retry-denied.lookup", 2)],
    [6, d.nodeFailed("lookup", 1, "tool", 2, "NODE_EXECUTION_FAILED", "AUTHORIZATION")],
    [7, d.runFailed("NODE_EXECUTION_FAILED", "AUTHORIZATION", 1, "lookup")],
  ]);

  // Operational budget evidence: 23 s Run, one retry, two physical Tool calls.
  const budgetTrace = await traceOf(id("run.eval.budget"), [
    [0, d.runStarted("lookup", 2, [{ nodeId: "lookup", maxAttempts: 3 }])],
    [1, d.nodeStarted("lookup", 1, "tool", 1, false, 3)],
    [2, d.toolStarted("lookup", 1, "tex.budget.lookup", LOOKUP, 1)],
    [5, d.toolFailed("lookup", 1, "tex.budget.lookup", 1)],
    [5, d.retryScheduled("lookup", 1, 1, "TRANSIENT_DEPENDENCY", "TOOL_EXECUTION_FAILED")],
    [6, d.nodeStarted("lookup", 1, "tool", 2, false, 3)],
    [7, d.toolStarted("lookup", 1, "tex.budget.lookup", LOOKUP, 2)],
    [10, d.toolCompleted("lookup", 1, "tex.budget.lookup", LOOKUP, 2)],
    [10, d.stateUpdated("lookup", 1, 1, ["lookupResult"])],
    [11, d.nodeCompleted("lookup", 1, "tool", 2, 0, 1)],
    [11, d.route("lookup", "final")],
    [12, d.nodeStarted("final", 2, "final_output")],
    [22, d.nodeCompleted("final", 2, "final_output", 1, 1, 1)],
    [23, d.runCompleted(2, 1)],
  ]);

  // Token usage recorded, no trusted pricing profile: modelled cost is unavailable, never zero.
  const unpricedTrace = await traceOf(id("run.eval.unpriced"), [
    [0, d.runStarted("summarize", 2)],
    [1, d.nodeStarted("summarize", 1, "model")],
    [2, d.modelStarted("summarize", 1, "inv.unpriced", "binding.default", { provider: "example", model: "example-model" })],
    [3, d.modelCompleted("summarize", 1, "inv.unpriced", "binding.default", { provider: "example", model: "example-model" }, { inputTokens: 900, outputTokens: 100, totalTokens: 1000 })],
    [4, d.stateUpdated("summarize", 1, 1, ["summary"])],
    [5, d.nodeCompleted("summarize", 1, "model", 1, 0, 1)],
    [6, d.route("summarize", "final")],
    [7, d.nodeStarted("final", 2, "final_output")],
    [8, d.nodeCompleted("final", 2, "final_output", 1, 1, 1)],
    [9, d.runCompleted(2, 1)],
  ]);

  // Corrupt evidence: one committed event removed (sequence gap). Untrustworthy, not a behavior violation.
  const corrupt = (approved.bundle.trace as unknown[]).filter((_, index) => index !== 5);

  // Execution-only evidence (no Trace), and the same Run with an unexpected extra state write.
  const execution = approved.bundle.execution!;
  const unexpectedWrite = { ...execution, state: { ...execution.state, revision: execution.state.revision + 1, values: { ...execution.state.values, forbiddenKey: { injected: true } } } };

  return {
    "flagship-approved": approved.bundle,
    "approval-rejected": rejected.bundle,
    "approval-pending": pending.bundle,
    "authorization-denied": denied.bundle,
    "durable-replay": recorded("run.eval.replay", replay, { metrics: metricsOf(replay) }),
    "portability-provider-a": recorded("run.portability.a", portabilityA),
    "portability-provider-b": recorded("run.portability.b", portabilityB),
    "negative-forbidden-tool": recorded("run.eval.forbidden", forbiddenTool),
    "negative-tool-after-rejection": recorded("run.eval.after-rejection", toolAfterRejection),
    "negative-approval-bypass": recorded("run.eval.bypass", approvalBypass),
    "negative-denied-then-executed": recorded("run.eval.denied-executed", deniedThenExecuted),
    "negative-retry-after-denial": recorded("run.eval.retry-denied", retryAfterDenial),
    "negative-state-unexpected-write": { origin: "recorded", runId: "run.eval.flagship", execution: unexpectedWrite },
    "execution-only": { origin: "recorded", runId: "run.eval.flagship", execution },
    "metrics-budget": recorded("run.eval.budget", budgetTrace, { metrics: metricsOf(budgetTrace) }),
    "metrics-cost-unavailable": recorded("run.eval.unpriced", unpricedTrace, { metrics: metricsOf(unpricedTrace) }),
    "corrupt-trace-gap": recorded("run.eval.flagship", corrupt),
  };
}
