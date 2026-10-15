import type { JsonValue, NodeId, RunRecord, RunState } from "@aao/contracts";
import { createSystemClock, type RuntimeClock } from "./clock.js";
import { captureExecutionSnapshot, validateSnapshotAgainstPlan, type RuntimeExecutionSnapshot } from "./execution-snapshot.js";
import { initializeNodeStatuses, transitionNodeStatus, type NodeStatusMap } from "./node-lifecycle.js";
import { runPreflight } from "./preflight.js";
import { executeNodeAttempts, resolveReliability, type ResolvedReliability } from "./reliability.js";
import { createRunTracer, nodeSpan, runSpan, type RunTracer } from "./tracing.js";
import { createRunRecord, setCurrentNodeId, transitionRunRecord } from "./run-lifecycle.js";
import { validateRuntimeInput } from "./runtime-input-validation.js";
import { compareIsoInstants } from "./timestamps.js";
import { applyStatePatch, cloneRunState } from "./state.js";
import { validateExecutionAgainstPlan } from "./execution-records.js";
import type { ContinueWaitingWorkflowRequest, ExecuteWorkflowRequest, NodeExecutionRecord, NodeRecoveryDirective, ResumeWorkflowRequest, RuntimeDurabilityHooks, RuntimeExecutionState, RuntimeFailure, WorkflowExecutionResult } from "./types.js";

/**
 * The bounded allowance added on top of a plan's node count when computing
 * the default `maxSteps` ceiling. Workflow Compiler V1 already rejects
 * cycles, so this exists purely as protection against a corrupted plan or a
 * future Runtime implementation bug — not as a feature workflows are
 * expected to rely on.
 */
const DEFAULT_MAX_STEPS_ALLOWANCE = 5;

/**
 * Executes a `CompiledWorkflowPlan` end to end as a *managed* run: creates
 * an authoritative `RunRecord`, walks it through the canonical Run
 * lifecycle (`CREATED -> VALIDATING -> QUEUED -> RUNNING -> COMPLETED |
 * WAITING_FOR_APPROVAL | FAILED`), maintains authoritative Node lifecycle for every plan Node, and
 * captures a safe `RuntimeExecutionSnapshot` at every safe execution
 * boundary. See `docs/architecture/runtime-state-management.md` and
 * ADR-010 for the full state model this function implements, and
 * `docs/architecture/runtime-v1.md` for what Runtime V1 deliberately does
 * not support yet (conditional routing). With `options.durability` every
 * safe boundary and attempt is persisted through the host's port (ADR-019). Each
 * Node executes through the bounded Reliability Controller (ADR-018).
 */
export async function executeWorkflow(request: ExecuteWorkflowRequest): Promise<WorkflowExecutionResult> {
  // The request itself may not be trustworthy enough to construct a Run at
  // all (malformed plan/state/registry/options) — see
  // docs/architecture/runtime-state-management.md ("basic invalid input vs
  // managed run failure"). No RunRecord, and therefore no execution/
  // snapshot, exists yet at this point.
  const inputFailure = validateRuntimeInput(request);
  if (inputFailure) return { ok: false, failure: inputFailure };

  const { runId, plan, registry } = request;
  // Trusted reliability configuration is validated against the plan before a Run exists, like any other input.
  const resolved = resolveReliability(request.options, plan);
  if (!resolved.ok) return { ok: false, failure: resolved.failure };
  const clock: RuntimeClock = request.options?.clock ?? createSystemClock();
  const hooks = request.options?.durability;
  const maxSteps = request.options?.maxSteps ?? Object.keys(plan.nodesById).length + DEFAULT_MAX_STEPS_ALLOWANCE;

  let run: RunRecord = createRunRecord({ runId, workflowId: plan.workflow.id, workflowVersion: plan.workflow.version }, clock);
  run = transitionRunRecord(run, "VALIDATING", clock.now());
  // Observational only (ADR-020): a Run now exists, so its trace begins. Nothing below reads the trace.
  const tracer = createRunTracer(request.options?.trace, { runId, workflowId: plan.workflow.id, workflowVersion: plan.workflow.version });
  await tracer.emit({ type: "run.started", span: runSpan(), key: {}, payload: { entryNodeId: plan.entryNodeId, initialStateRevision: request.initialState.revision, nodeCount: Object.keys(plan.nodesById).length, reliabilityPolicies: resolved.reliability.configured() } });

  const allNodeIds = Object.keys(plan.nodesById);
  let nodeStatusesById: NodeStatusMap = initializeNodeStatuses(allNodeIds);

  const preflightFailure = runPreflight(plan, registry);
  if (preflightFailure) {
    // Preflight failure is a managed Run failure, not an input failure: the
    // request was trustworthy enough to create a Run, so the failure must
    // be authoritative (RunRecord.status = FAILED) with a safe snapshot —
    // never a silent rejection with no Run of record. No Node ever became
    // READY or RUNNING, and no executor was ever invoked.
    run = setCurrentNodeId(transitionRunRecord(run, "FAILED", clock.now()), undefined);
    const execution: RuntimeExecutionState = { run, state: cloneRunState(request.initialState), nodeStatusesById, step: 0, history: [] };
    const boundary = await persistBoundary(hooks, clock, execution, undefined, preflightFailure);
    if (!boundary.ok) return traceAbort(tracer, boundary.result);
    await traceTerminalFailure(tracer, execution, preflightFailure);
    return { ok: false, failure: preflightFailure, execution, latestSnapshot: boundary.snapshot };
  }

  // QUEUED is an intentional, transient in-process lifecycle state: it means
  // "validation passed and this execution is eligible to run", not a
  // durable queue/worker/broker. The local Runtime immediately claims
  // available execution capacity — see docs/architecture/runtime-state-management.md.
  run = transitionRunRecord(run, "QUEUED", clock.now());
  run = transitionRunRecord(run, "RUNNING", clock.now());

  const currentNodeId: NodeId = plan.entryNodeId;
  nodeStatusesById = transitionNodeStatus(nodeStatusesById, currentNodeId, "READY");
  run = setCurrentNodeId(run, currentNodeId);

  const state: RunState = cloneRunState(request.initialState);
  const history: NodeExecutionRecord[] = [];
  const step = 0;

  const execution: RuntimeExecutionState = { run, state, nodeStatusesById, step, history };
  // The first durable boundary (RUNNING, entry READY) exists before any executor can become eligible.
  const boundary = await persistBoundary(hooks, clock, execution, undefined);
  if (!boundary.ok) return traceAbort(tracer, boundary.result);

  return runLoop({ runId, plan, registry, clock, maxSteps, reliability: resolved.reliability, hooks, tracer, execution, latestSnapshot: boundary.snapshot, currentNodeId });
}

/**
 * Validated in-process continuation. The exact request is checked before
 * the waiting execution is used. The caller's `execution` is never mutated
 * (ADR-025): continuation works on a detached copy that preserves Run
 * identity, workflow identity, history, revision, approval references, and
 * attempt counts exactly, and returns the new `RuntimeExecutionState`.
 */
export async function continueWaitingWorkflow(request: ContinueWaitingWorkflowRequest): Promise<WorkflowExecutionResult> {
  const { approval, plan, registry } = request;
  let execution = request.execution;
  const wait = execution.wait;
  const invalid = (code: RuntimeFailure["code"]): WorkflowExecutionResult => ({ ok: false, failure: { code, message: code }, execution });
  if (execution.run.status !== "WAITING_FOR_APPROVAL" || !wait || wait.kind !== "approval" || execution.run.currentNodeId !== wait.nodeId || execution.nodeStatusesById[wait.nodeId] !== "WAITING" || plan.nodesById[wait.nodeId]?.kind !== "approval") return invalid("INVALID_APPROVAL_CONTEXT");
  if (approval.approvalId !== wait.referenceId || approval.runId !== execution.run.runId || approval.nodeId !== wait.nodeId || approval.requestFingerprint !== wait.requestFingerprint || request.currentRequestFingerprint !== wait.requestFingerprint) return invalid("APPROVAL_REQUEST_MISMATCH");
  if (!["pending", "approved", "rejected", "expired", "cancelled"].includes(approval.status)) return invalid("INVALID_APPROVAL_CONTEXT");
  if (approval.status === "pending") return invalid("APPROVAL_STILL_PENDING");
  const resolved = resolveReliability(request.options, plan);
  if (!resolved.ok) return { ok: false, failure: resolved.failure, execution };
  const hooksFailure = validateDurabilityHooks(request.options?.durability) ?? validateTracePort(request.options?.trace);
  if (hooksFailure) return { ok: false, failure: hooksFailure, execution };
  const hooks = request.options?.durability;
  const tracer = createRunTracer(request.options?.trace, { runId: execution.run.runId, workflowId: plan.workflow.id, workflowVersion: plan.workflow.version });
  const clock = flooredClock(request.options?.clock ?? createSystemClock(), execution.run.updatedAt);
  let snapshot: RuntimeExecutionSnapshot;
  try { snapshot = captureExecutionSnapshot(execution, clock.now()); }
  catch { return invalid("INVALID_APPROVAL_CONTEXT"); }
  const compatibility = validateSnapshotAgainstPlan(snapshot, plan);
  if (compatibility || runPreflight(plan, registry)) return invalid("INVALID_APPROVAL_CONTEXT");
  const node = plan.nodesById[wait.nodeId];
  if (!node) return invalid("INVALID_APPROVAL_CONTEXT");
  const next = plan.outgoingEdgesByNode[wait.nodeId]?.[0]?.targetNodeId;
  if (approval.status === "approved" && (!next || execution.nodeStatusesById[next] !== "PENDING")) return invalid("INVALID_APPROVAL_CONTEXT");
  // From here on the Run advances: only a detached copy changes, never the caller's input.
  try { execution = cloneExecution(execution); }
  catch { return invalid("INVALID_APPROVAL_CONTEXT"); }
  // The waiting boundary is the last durable truth until the resolution boundary below is persisted.
  const waitingBoundary = { execution: cloneExecution(execution), snapshot };
  const terminal = approval.status === "cancelled" ? "CANCELLED" : "FAILED";
  execution.nodeStatusesById = transitionNodeStatus(execution.nodeStatusesById, wait.nodeId, approval.status === "approved" ? "SUCCEEDED" : terminal);
  execution.run = transitionRunRecord(execution.run, approval.status === "approved" ? "RUNNING" : terminal, clock.now());
  delete execution.wait;
  // attemptCount 1: the single attempt that requested the wait. Approval nodes cannot carry a retry policy, and continuation invokes no executor.
  execution.history = [...execution.history, { nodeId: node.id, kind: node.kind, step: execution.step, status: approval.status === "approved" ? "SUCCEEDED" : "FAILED", stateRevisionBefore: execution.state.revision, stateRevisionAfter: execution.state.revision, attemptCount: 1 }];
  if (approval.status !== "approved") {
    execution.run = setCurrentNodeId(execution.run, undefined);
    const code = approval.status === "rejected" ? "APPROVAL_REJECTED" : approval.status === "expired" ? "APPROVAL_EXPIRED" : "APPROVAL_CANCELLED";
    const failure: RuntimeFailure = { code, message: code, nodeId: node.id, category: "APPROVAL", retryable: false };
    const boundary = await persistBoundary(hooks, clock, execution, waitingBoundary, failure);
    if (!boundary.ok) return traceAbort(tracer, boundary.result);
    if (approval.status !== "cancelled") await tracer.emit({ type: "node.failed", nodeId: node.id, span: nodeSpan(node.id, execution.step, 1), parentSpan: runSpan(), key: { step: execution.step }, payload: { kind: node.kind, step: execution.step, attemptCount: 1, code, category: "APPROVAL", retryable: false } });
    await traceTerminalFailure(tracer, execution, failure);
    return { ok: false, failure, execution, latestSnapshot: boundary.snapshot };
  }
  execution.nodeStatusesById = transitionNodeStatus(execution.nodeStatusesById, next!, "READY");
  execution.run = setCurrentNodeId(execution.run, next);
  const boundary = await persistBoundary(hooks, clock, execution, waitingBoundary);
  if (!boundary.ok) return traceAbort(tracer, boundary.result);
  await tracer.emit({ type: "node.completed", nodeId: node.id, span: nodeSpan(node.id, execution.step, 1), parentSpan: runSpan(), key: { step: execution.step }, payload: { kind: node.kind, step: execution.step, attemptCount: 1, stateRevisionBefore: execution.state.revision, stateRevisionAfter: execution.state.revision, outcomeSource: "approval_resolution" } });
  await tracer.emit({ type: "route.selected", span: runSpan(), key: { step: execution.step }, payload: { sourceNodeId: node.id, targetNodeId: next!, routeType: "unconditional" } });
  return runLoop({ runId: execution.run.runId, plan, registry, clock, maxSteps: request.options?.maxSteps ?? Object.keys(plan.nodesById).length + DEFAULT_MAX_STEPS_ALLOWANCE, reliability: resolved.reliability, hooks, tracer, execution, latestSnapshot: boundary.snapshot, currentNodeId: next! });
}

/**
 * The general Runtime resume primitive (ADR-019). Takes an execution
 * captured at a safe boundary — typically reconstructed from a durable
 * checkpoint by a host; this function never touches storage — validates it
 * against the plan, and continues it through the same single Runtime loop
 * `executeWorkflow` uses. It never creates a Run: identity and `createdAt`
 * are preserved.
 *
 * - `RUNNING` (current Node `READY`): continue that Node, applying the
 *   optional recovery directive so durably recorded attempts are reused.
 * - `WAITING_FOR_APPROVAL`: stays waiting (approval continuation is
 *   `continueWaitingWorkflow`), unless safe-boundary cancellation was requested.
 * - `COMPLETED`, `FAILED`, `CANCELLED`: returned as-is; nothing executes.
 *
 * The caller's `execution` is never mutated.
 */
export async function resumeWorkflow(request: ResumeWorkflowRequest): Promise<WorkflowExecutionResult> {
  const { plan, registry, recovery } = request;
  if (typeof request?.execution !== "object" || request.execution === null) return { ok: false, failure: { code: "INVALID_RUNTIME_INPUT", message: "request.execution must be a RuntimeExecutionState." } };
  const inputFailure = validateRuntimeInput({ runId: request.execution.run?.runId, plan, initialState: request.execution.state, registry, ...(request.options ? { options: request.options } : {}) });
  if (inputFailure) return { ok: false, failure: inputFailure };
  const resolved = resolveReliability(request.options, plan);
  if (!resolved.ok) return { ok: false, failure: resolved.failure };
  let execution: RuntimeExecutionState;
  try { execution = cloneExecution(request.execution); }
  catch { return { ok: false, failure: { code: "INVALID_EXECUTION_SNAPSHOT", message: "request.execution is not JSON-safe." } }; }
  const incompatible = validateExecutionAgainstPlan(execution, plan);
  if (incompatible) return { ok: false, failure: incompatible };
  const clock = flooredClock(request.options?.clock ?? createSystemClock(), execution.run.updatedAt);
  const hooks = request.options?.durability;
  const latestSnapshot = captureExecutionSnapshot(execution, execution.run.updatedAt);
  const maxSteps = request.options?.maxSteps ?? Object.keys(plan.nodesById).length + DEFAULT_MAX_STEPS_ALLOWANCE;
  const durable = { execution: cloneExecution(execution), snapshot: latestSnapshot };
  const tracer = createRunTracer(request.options?.trace, { runId: execution.run.runId, workflowId: plan.workflow.id, workflowVersion: plan.workflow.version });

  switch (execution.run.status) {
    case "COMPLETED": {
      const terminal = [...execution.history].reverse().find((record) => plan.terminalNodeIds.includes(record.nodeId) && record.status === "SUCCEEDED");
      const output: JsonValue | undefined = terminal?.output;
      return { ok: true, execution, latestSnapshot, ...(output !== undefined ? { output } : {}) };
    }
    case "FAILED":
    case "CANCELLED":
      return { ok: false, failure: { code: "RUN_ALREADY_TERMINAL", message: `Run is already ${execution.run.status}; nothing executes.`, details: { status: execution.run.status } }, execution, latestSnapshot };
    case "WAITING_FOR_APPROVAL": {
      if (recovery) return { ok: false, failure: { code: "INVALID_RECOVERY_DIRECTIVE", message: "A waiting Run has no Node attempt to recover." }, execution, latestSnapshot };
      const cancel = await cancellationRequested(hooks, execution.run.runId);
      if (cancel === "error") return traceAbort(tracer, { ok: false, failure: { code: "DURABILITY_PERSISTENCE_FAILED", message: "Durable cancellation state could not be read." }, execution, latestSnapshot });
      if (!cancel) return { ok: true, execution, latestSnapshot };
      const wait = execution.wait!;
      const node = plan.nodesById[wait.nodeId]!;
      execution.nodeStatusesById = transitionNodeStatus(execution.nodeStatusesById, wait.nodeId, "CANCELLED");
      execution.run = setCurrentNodeId(transitionRunRecord(execution.run, "CANCELLED", clock.now()), undefined);
      delete execution.wait;
      execution.history = [...execution.history, { nodeId: node.id, kind: node.kind, step: execution.step, status: "FAILED", stateRevisionBefore: execution.state.revision, stateRevisionAfter: execution.state.revision, attemptCount: 1 }];
      const failure: RuntimeFailure = { code: "RUN_CANCELLED", message: "Run cancelled at a safe boundary while waiting for approval.", nodeId: node.id };
      const boundary = await persistBoundary(hooks, clock, execution, durable, failure);
      if (!boundary.ok) return traceAbort(tracer, boundary.result);
      await traceTerminalFailure(tracer, execution, failure);
      return { ok: false, failure, execution, latestSnapshot: boundary.snapshot };
    }
    case "RUNNING": {
      const currentNodeId = execution.run.currentNodeId!;
      if (recovery && (recovery.nodeId !== currentNodeId || recovery.step !== execution.step + 1 || !Array.isArray(recovery.priorOutcomes))) {
        return { ok: false, failure: { code: "INVALID_RECOVERY_DIRECTIVE", message: "Recovery directive does not target the current READY Node at the next step." }, execution, latestSnapshot };
      }
      const preflightFailure = runPreflight(plan, registry);
      if (preflightFailure) return { ok: false, failure: preflightFailure, execution, latestSnapshot };
      return runLoop({ runId: execution.run.runId, plan, registry, clock, maxSteps, reliability: resolved.reliability, hooks, tracer, execution, latestSnapshot, currentNodeId, ...(recovery ? { recovery } : {}) });
    }
    default:
      return { ok: false, failure: { code: "INVALID_EXECUTION_SNAPSHOT", message: `A ${execution.run.status} Run is never a resumable safe boundary.` }, execution, latestSnapshot };
  }
}

type DurableBoundary = { execution: RuntimeExecutionState; snapshot: RuntimeExecutionSnapshot };

/**
 * Captures a safe boundary and, in durable mode, persists it before the
 * caller may proceed or return. On a rejected write the Runtime reports the
 * *previous* durable boundary unchanged — never an in-memory state that was
 * not persisted.
 */
async function persistBoundary(hooks: RuntimeDurabilityHooks | undefined, clock: RuntimeClock, execution: RuntimeExecutionState, previous: DurableBoundary | undefined, failure?: RuntimeFailure): Promise<{ ok: true; snapshot: RuntimeExecutionSnapshot } | { ok: false; result: WorkflowExecutionResult }> {
  const snapshot = captureExecutionSnapshot(execution, clock.now());
  if (hooks) {
    try {
      await hooks.persistCheckpoint({ execution: cloneExecution(execution), snapshot: JSON.parse(JSON.stringify(snapshot)) as RuntimeExecutionSnapshot, ...(failure ? { failure: JSON.parse(JSON.stringify(failure)) as RuntimeFailure } : {}) });
    } catch {
      return { ok: false, result: durabilityFailure(previous) };
    }
  }
  return { ok: true, snapshot };
}

function durabilityFailure(previous: DurableBoundary | undefined): WorkflowExecutionResult {
  const failure: RuntimeFailure = { code: "DURABILITY_PERSISTENCE_FAILED", message: "A durability write failed; execution stopped at the last durably persisted boundary." };
  return previous ? { ok: false, failure, execution: cloneExecution(previous.execution), latestSnapshot: previous.snapshot } : { ok: false, failure };
}

async function cancellationRequested(hooks: RuntimeDurabilityHooks | undefined, runId: string): Promise<boolean | "error"> {
  if (!hooks) return false;
  try { return (await hooks.isCancellationRequested(runId)) === true; } catch { return "error"; }
}

function validateDurabilityHooks(hooks: unknown): RuntimeFailure | undefined {
  if (hooks === undefined) return undefined;
  const candidate = hooks as Record<string, unknown> | null;
  const ok = typeof candidate === "object" && candidate !== null && ["persistCheckpoint", "beginAttempt", "recordAttemptOutcome", "isCancellationRequested"].every((name) => typeof candidate[name] === "function");
  return ok ? undefined : { code: "INVALID_RUNTIME_INPUT", message: "request.options.durability must implement persistCheckpoint, beginAttempt, recordAttemptOutcome, and isCancellationRequested." };
}

function validateTracePort(trace: unknown): RuntimeFailure | undefined {
  if (trace === undefined) return undefined;
  return typeof trace === "object" && trace !== null && typeof (trace as Record<string, unknown>).emit === "function" ? undefined : { code: "INVALID_RUNTIME_INPUT", message: "request.options.trace must implement emit(draft)." };
}

/** Reports a Run-level failure the Runtime detected without a terminal Run transition (e.g. a durability write failed). */
async function traceAbort(tracer: RunTracer, result: WorkflowExecutionResult): Promise<WorkflowExecutionResult> {
  if (!result.ok) await tracer.emit({ type: "failure.detected", span: runSpan(), key: { code: result.failure.code, step: result.execution?.step ?? 0 }, payload: { source: "runtime", code: result.failure.code } });
  return result;
}

/**
 * Reports a committed terminal Run failure, mirroring `RunRecord.status`
 * exactly: FAILED → `failure.detected` + `run.failed`; CANCELLED →
 * (`cancellation.applied` for a requested cancellation) + `run.cancelled`.
 */
async function traceTerminalFailure(tracer: RunTracer, execution: RuntimeExecutionState, failure: RuntimeFailure): Promise<void> {
  const totals = { stateRevision: execution.state.revision, steps: execution.step };
  if (execution.run.status === "CANCELLED") {
    if (failure.code === "RUN_CANCELLED") await tracer.emit({ type: "cancellation.applied", ...(failure.nodeId ? { nodeId: failure.nodeId } : {}), span: runSpan(), key: {}, payload: { code: failure.code, step: execution.step } });
    await tracer.emit({ type: "run.cancelled", span: runSpan(), key: {}, payload: { code: failure.code, ...(failure.nodeId ? { nodeId: failure.nodeId } : {}), ...totals } });
    return;
  }
  await tracer.emit({
    type: "failure.detected",
    ...(failure.nodeId ? { nodeId: failure.nodeId } : {}),
    span: runSpan(),
    key: { code: failure.code, step: failure.step ?? execution.step },
    payload: { source: "runtime", code: failure.code, ...(failure.category ? { category: failure.category } : {}), ...(failure.step !== undefined ? { step: failure.step } : {}), ...(failure.attempt !== undefined ? { attempt: failure.attempt } : {}), ...(failure.causeCode ? { causeCode: failure.causeCode } : {}), ...(failure.executorFailure ? { executorFailure: { namespace: failure.executorFailure.namespace, code: failure.executorFailure.code } } : {}) },
  });
  await tracer.emit({ type: "run.failed", span: runSpan(), key: {}, payload: { code: failure.code, ...(failure.category ? { category: failure.category } : {}), ...(failure.nodeId ? { nodeId: failure.nodeId } : {}), ...totals } });
}

/**
 * A continuation may run in a later process whose clock is behind the
 * persisted lifecycle time. Run lifecycle time must never move backwards,
 * so the continuing clock is floored at the execution's `run.updatedAt`
 * (an invalid floor leaves the clock unchanged and lifecycle validation decides).
 */
function flooredClock(clock: RuntimeClock, floor: string): RuntimeClock {
  return {
    now(): string {
      const now = clock.now();
      try { return compareIsoInstants(now, floor) < 0 ? floor : now; } catch { return now; }
    },
  };
}

function cloneExecution(execution: RuntimeExecutionState): RuntimeExecutionState {
  return JSON.parse(JSON.stringify(execution)) as RuntimeExecutionState;
}

async function runLoop(params: { runId: ExecuteWorkflowRequest["runId"]; plan: ExecuteWorkflowRequest["plan"]; registry: ExecuteWorkflowRequest["registry"]; clock: RuntimeClock; maxSteps: number; reliability: ResolvedReliability; hooks: RuntimeDurabilityHooks | undefined; tracer: RunTracer; execution: RuntimeExecutionState; latestSnapshot: RuntimeExecutionSnapshot; currentNodeId: NodeId; recovery?: NodeRecoveryDirective }): Promise<WorkflowExecutionResult> {
  const { runId, plan, registry, clock, maxSteps, reliability, hooks, tracer } = params;
  let { execution, latestSnapshot, currentNodeId } = params;
  let recovery = params.recovery;
  let { run, state, nodeStatusesById, step, history } = execution;
  const terminalNodeIds = new Set(plan.terminalNodeIds);
  // The last durably persisted boundary (every boundary in non-durable mode).
  let durable: DurableBoundary = { execution: cloneExecution(execution), snapshot: latestSnapshot };

  /** Commits and persists a safe boundary; on a persistence failure returns the previous durable boundary. */
  async function boundary(next: RuntimeExecutionState, failure?: RuntimeFailure): Promise<WorkflowExecutionResult | undefined> {
    const persisted = await persistBoundary(hooks, clock, next, durable, failure);
    if (!persisted.ok) return traceAbort(tracer, persisted.result);
    execution = next;
    latestSnapshot = persisted.snapshot;
    durable = { execution: cloneExecution(next), snapshot: latestSnapshot };
    return undefined;
  }

  /** Commits a terminal Run failure from the *last safe boundary* (`execution` as currently committed) and captures its snapshot. Used by every failure path that has not itself already advanced `execution`. */
  async function fail(failure: RuntimeFailure, failedNode?: { kind: NodeExecutionRecord["kind"]; attemptCount: number }, committed?: () => Promise<void>): Promise<WorkflowExecutionResult> {
    run = setCurrentNodeId(transitionRunRecord(run, "FAILED", clock.now()), undefined);
    const aborted = await boundary({ ...execution, run }, failure);
    if (aborted) return aborted;
    await committed?.();
    if (failedNode && failure.nodeId !== undefined && failure.step !== undefined) {
      await tracer.emit({ type: "node.failed", nodeId: failure.nodeId, span: nodeSpan(failure.nodeId, failure.step, failedNode.attemptCount), parentSpan: runSpan(), key: { step: failure.step }, payload: { kind: failedNode.kind, step: failure.step, attemptCount: failedNode.attemptCount, code: failure.code, ...(failure.category ? { category: failure.category } : {}), ...(failure.retryable !== undefined ? { retryable: failure.retryable } : {}), ...(failure.causeCode ? { causeCode: failure.causeCode } : {}), ...(failure.executorFailure ? { executorFailure: { namespace: failure.executorFailure.namespace, code: failure.executorFailure.code } } : {}) } });
    }
    await traceTerminalFailure(tracer, execution, failure);
    return { ok: false, failure, execution, latestSnapshot };
  }
  const abort = (result: WorkflowExecutionResult) => traceAbort(tracer, result);

  for (;;) {
    // Safe-boundary cancellation: checked only before a Node would invoke an
    // executor, never mid-attempt. A durably recorded accepted outcome is
    // committed first — cancellation stops future work, it does not erase history.
    const recordedFinal = recovery !== undefined && recovery.replayAttempt === undefined && recovery.priorOutcomes.length > 0 && recovery.priorOutcomes[recovery.priorOutcomes.length - 1]!.kind !== "failure";
    if (!recordedFinal) {
      const cancel = await cancellationRequested(hooks, runId);
      if (cancel === "error") return abort(durabilityFailure(durable));
      if (cancel) {
        const cancelled: RuntimeFailure = { code: "RUN_CANCELLED", message: "Run cancelled at a safe boundary before the next Node began.", nodeId: currentNodeId };
        nodeStatusesById = transitionNodeStatus(nodeStatusesById, currentNodeId, "CANCELLED");
        run = setCurrentNodeId(transitionRunRecord(run, "CANCELLED", clock.now()), undefined);
        const aborted = await boundary({ run, state, nodeStatusesById, step, history }, cancelled);
        if (aborted) return aborted;
        await traceTerminalFailure(tracer, execution, cancelled);
        return { ok: false, failure: cancelled, execution, latestSnapshot };
      }
    }

    step += 1;
    if (step > maxSteps) {
      // The defensive step ceiling is a Runtime-level failure, not a
      // specific Node's failure: no Node is attributed FAILED, and the last
      // committed `execution` (the previous safe boundary) is preserved
      // as-is other than the Run transition itself.
      return fail({
        code: "MAX_STEPS_EXCEEDED",
        message: `Runtime V1 execution exceeded the maximum of ${maxSteps} step(s).`,
        step,
        details: { maxSteps },
      });
    }

    // Guaranteed to resolve: preflight verified every plan node has both an
    // executor and consistent routing before this loop began. Kept as a
    // defensive check anyway, matching Runtime V1's existing corrupted-plan
    // posture elsewhere in this package.
    const node = plan.nodesById[currentNodeId];
    if (node === undefined) {
      return fail({ code: "RUNTIME_PREFLIGHT_FAILED", message: `Node "${currentNodeId}" does not resolve mid-execution.`, nodeId: currentNodeId, step });
    }
    const executor = registry.get(node.kind);
    if (executor === undefined) {
      return fail({ code: "NODE_EXECUTOR_NOT_FOUND", message: `No executor registered for node kind "${node.kind}" (node "${node.id}").`, nodeId: node.id, step });
    }

    nodeStatusesById = transitionNodeStatus(nodeStatusesById, node.id, "RUNNING");

    // Retries are internal to this one RUNNING lifecycle: no READY/RUNNING
    // bounce, no RETRYING Run status, no snapshot mid-attempt. The controller
    // returns at most one accepted outcome — live, or durably recorded and
    // recovered — and only this loop commits it.
    const outcome = await executeNodeAttempts({ runId, node, executor, state, step, policy: reliability.policyFor(node.id), sleeper: reliability.sleeper, hooks, ...(tracer.enabled ? { tracer } : {}), ...(recovery ? { recovery } : {}) });
    recovery = undefined;
    if (outcome.kind === "durability_failure") return abort(durabilityFailure(durable));
    if (outcome.kind === "invalid_recovery") return abort({ ok: false, failure: { code: "INVALID_RECOVERY_DIRECTIVE", message: outcome.message, nodeId: node.id, step }, execution: cloneExecution(durable.execution), latestSnapshot: durable.snapshot });
    const attemptEvidence = { attemptCount: outcome.attemptCount, ...(outcome.attemptFailures.length > 0 ? { attemptFailures: outcome.attemptFailures } : {}) };

    if (outcome.kind === "failure") {
      // No state patch is ever applied from a failed, invalid, or timed-out
      // attempt — the revision before/after this record are identical.
      nodeStatusesById = transitionNodeStatus(nodeStatusesById, node.id, "FAILED");
      history = [...history, { nodeId: node.id, kind: node.kind, step, status: "FAILED", stateRevisionBefore: state.revision, stateRevisionAfter: state.revision, ...attemptEvidence }];
      execution = { run, state, nodeStatusesById, step, history };
      return fail(outcome.failure, { kind: node.kind, attemptCount: outcome.attemptCount });
    }

    if (outcome.kind === "wait") {
      nodeStatusesById = transitionNodeStatus(nodeStatusesById, node.id, "WAITING");
      run = transitionRunRecord(run, "WAITING_FOR_APPROVAL", clock.now());
      // A durable wait is reported only after its wait boundary is persisted.
      const aborted = await boundary({ run, state, nodeStatusesById, step, history, wait: { ...outcome.wait, nodeId: node.id } });
      if (aborted) return aborted;
      await tracer.emit({ type: "node.waiting", nodeId: node.id, span: nodeSpan(node.id, step, outcome.attemptCount), parentSpan: runSpan(), key: { step }, payload: { kind: node.kind, step, waitKind: "approval", referenceId: outcome.wait.referenceId } });
      return { ok: true, execution, latestSnapshot };
    }

    const stateRevisionBefore = state.revision;
    // Commit-on-success: exactly one accepted attempt's patch, applied once.
    state = applyStatePatch(state, outcome.statePatch);
    const stateRevisionAfter = state.revision;

    nodeStatusesById = transitionNodeStatus(nodeStatusesById, node.id, "SUCCEEDED");
    history = [
      ...history,
      {
        nodeId: node.id,
        kind: node.kind,
        step,
        status: "SUCCEEDED",
        ...(outcome.output !== undefined ? { output: outcome.output } : {}),
        stateRevisionBefore,
        stateRevisionAfter,
        ...attemptEvidence,
      },
    ];

    /** Reported only after the boundary that commits this Node is persisted: Trace mirrors committed truth. */
    const traceCommit = async () => {
      if (outcome.statePatch !== undefined) await tracer.emit({ type: "state.updated", nodeId: node.id, span: nodeSpan(node.id, step, outcome.attemptCount), key: { step }, payload: { step, revisionBefore: stateRevisionBefore, revisionAfter: stateRevisionAfter, changedKeys: Object.keys(outcome.statePatch).sort() } });
      await tracer.emit({ type: "node.completed", nodeId: node.id, span: nodeSpan(node.id, step, outcome.attemptCount), parentSpan: runSpan(), key: { step }, payload: { kind: node.kind, step, attemptCount: outcome.attemptCount, stateRevisionBefore, stateRevisionAfter, outcomeSource: outcome.recovered ? "recovered" : "executor" } });
    };

    if (terminalNodeIds.has(node.id)) {
      run = setCurrentNodeId(transitionRunRecord(run, "COMPLETED", clock.now()), undefined);
      // COMPLETED is reported only after the terminal boundary is persisted.
      const aborted = await boundary({ run, state, nodeStatusesById, step, history });
      if (aborted) return aborted;
      await traceCommit();
      await tracer.emit({ type: "run.completed", span: runSpan(), key: {}, payload: { finalNodeId: node.id, stateRevision: state.revision, steps: step } });
      const output = outcome.output;
      return { ok: true, execution, latestSnapshot, ...(output !== undefined ? { output } : {}) };
    }

    // Preflight guarantees exactly one outgoing edge for every non-terminal node.
    const nextEdge = plan.outgoingEdgesByNode[node.id]?.[0];
    if (nextEdge === undefined) {
      execution = { run, state, nodeStatusesById, step, history };
      return fail({ code: "RUNTIME_PREFLIGHT_FAILED", message: `Non-terminal node "${node.id}" has no outgoing edge mid-execution.`, nodeId: node.id, step }, undefined, traceCommit);
    }
    currentNodeId = nextEdge.targetNodeId;
    // Workflow Compiler V1 rejects cycles, so a compiler-produced plan can
    // never route back to an already-visited (non-PENDING) node — but a
    // manually corrupted plan (see preflight/engine-safety tests) can. That
    // is plan corruption discovered mid-execution, matching every other
    // "mid-execution defensive" check in this loop: a graceful
    // RUNTIME_PREFLIGHT_FAILED, never an uncaught IllegalNodeTransitionError.
    if (nodeStatusesById[currentNodeId] !== "PENDING") {
      execution = { run, state, nodeStatusesById, step, history };
      return fail({
        code: "RUNTIME_PREFLIGHT_FAILED",
        message: `Routing revisits node "${currentNodeId}" (status "${nodeStatusesById[currentNodeId]}") mid-execution; Runtime V1 does not support re-entering a node.`,
        nodeId: currentNodeId,
        step,
      }, undefined, traceCommit);
    }
    nodeStatusesById = transitionNodeStatus(nodeStatusesById, currentNodeId, "READY");
    run = setCurrentNodeId(run, currentNodeId);

    const aborted = await boundary({ run, state, nodeStatusesById, step, history });
    if (aborted) return aborted;
    await traceCommit();
    await tracer.emit({ type: "route.selected", span: runSpan(), key: { step }, payload: { sourceNodeId: node.id, targetNodeId: currentNodeId, routeType: "unconditional" } });
  }
}
