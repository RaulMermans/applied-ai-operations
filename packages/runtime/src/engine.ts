import type { NodeId, RunRecord, RunState } from "@aao/contracts";
import { createSystemClock, type RuntimeClock } from "./clock.js";
import { captureExecutionSnapshot, validateSnapshotAgainstPlan, type RuntimeExecutionSnapshot } from "./execution-snapshot.js";
import { initializeNodeStatuses, transitionNodeStatus, type NodeStatusMap } from "./node-lifecycle.js";
import { runPreflight } from "./preflight.js";
import { executeNodeAttempts, resolveReliability, type ResolvedReliability } from "./reliability.js";
import { createRunRecord, setCurrentNodeId, transitionRunRecord } from "./run-lifecycle.js";
import { validateRuntimeInput } from "./runtime-input-validation.js";
import { applyStatePatch, cloneRunState } from "./state.js";
import type { ContinueWaitingWorkflowRequest, ExecuteWorkflowRequest, NodeExecutionRecord, RuntimeExecutionState, RuntimeFailure, WorkflowExecutionResult } from "./types.js";

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
 * not support yet (conditional routing, persistence, durable resume). Each
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
  const maxSteps = request.options?.maxSteps ?? Object.keys(plan.nodesById).length + DEFAULT_MAX_STEPS_ALLOWANCE;

  let run: RunRecord = createRunRecord({ runId, workflowId: plan.workflow.id, workflowVersion: plan.workflow.version }, clock);
  run = transitionRunRecord(run, "VALIDATING", clock.now());

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
    const latestSnapshot = captureExecutionSnapshot(execution, clock.now());
    return { ok: false, failure: preflightFailure, execution, latestSnapshot };
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
  const latestSnapshot: RuntimeExecutionSnapshot = captureExecutionSnapshot(execution, clock.now());

  return runLoop({ runId, plan, registry, clock, maxSteps, reliability: resolved.reliability, execution, latestSnapshot, currentNodeId });
}

/** Validated in-process continuation. The exact request is checked before consuming the waiting execution object. */
export async function continueWaitingWorkflow(request: ContinueWaitingWorkflowRequest): Promise<WorkflowExecutionResult> {
  const { execution, approval, plan, registry } = request;
  const wait = execution.wait;
  const invalid = (code: RuntimeFailure["code"]): WorkflowExecutionResult => ({ ok: false, failure: { code, message: code }, execution });
  if (execution.run.status !== "WAITING_FOR_APPROVAL" || !wait || wait.kind !== "approval" || execution.run.currentNodeId !== wait.nodeId || execution.nodeStatusesById[wait.nodeId] !== "WAITING" || plan.nodesById[wait.nodeId]?.kind !== "approval") return invalid("INVALID_APPROVAL_CONTEXT");
  if (approval.approvalId !== wait.referenceId || approval.runId !== execution.run.runId || approval.nodeId !== wait.nodeId || approval.requestFingerprint !== wait.requestFingerprint || request.currentRequestFingerprint !== wait.requestFingerprint) return invalid("APPROVAL_REQUEST_MISMATCH");
  if (!["pending", "approved", "rejected", "expired", "cancelled"].includes(approval.status)) return invalid("INVALID_APPROVAL_CONTEXT");
  if (approval.status === "pending") return invalid("APPROVAL_STILL_PENDING");
  const resolved = resolveReliability(request.options, plan);
  if (!resolved.ok) return { ok: false, failure: resolved.failure, execution };
  const clock = request.options?.clock ?? createSystemClock();
  let snapshot: RuntimeExecutionSnapshot;
  try { snapshot = captureExecutionSnapshot(execution, clock.now()); }
  catch { return invalid("INVALID_APPROVAL_CONTEXT"); }
  const compatibility = validateSnapshotAgainstPlan(snapshot, plan);
  if (compatibility || runPreflight(plan, registry)) return invalid("INVALID_APPROVAL_CONTEXT");
  const node = plan.nodesById[wait.nodeId];
  if (!node) return invalid("INVALID_APPROVAL_CONTEXT");
  const next = plan.outgoingEdgesByNode[wait.nodeId]?.[0]?.targetNodeId;
  if (approval.status === "approved" && (!next || execution.nodeStatusesById[next] !== "PENDING")) return invalid("INVALID_APPROVAL_CONTEXT");
  const terminal = approval.status === "cancelled" ? "CANCELLED" : "FAILED";
  execution.nodeStatusesById = transitionNodeStatus(execution.nodeStatusesById, wait.nodeId, approval.status === "approved" ? "SUCCEEDED" : terminal);
  execution.run = transitionRunRecord(execution.run, approval.status === "approved" ? "RUNNING" : terminal, clock.now());
  delete execution.wait;
  // attemptCount 1: the single attempt that requested the wait. Approval nodes cannot carry a retry policy, and continuation invokes no executor.
  execution.history = [...execution.history, { nodeId: node.id, kind: node.kind, step: execution.step, status: approval.status === "approved" ? "SUCCEEDED" : "FAILED", stateRevisionBefore: execution.state.revision, stateRevisionAfter: execution.state.revision, attemptCount: 1 }];
  if (approval.status !== "approved") {
    execution.run = setCurrentNodeId(execution.run, undefined);
    const code = approval.status === "rejected" ? "APPROVAL_REJECTED" : approval.status === "expired" ? "APPROVAL_EXPIRED" : "APPROVAL_CANCELLED";
    return { ok: false, failure: { code, message: code, nodeId: node.id, category: "APPROVAL", retryable: false }, execution, latestSnapshot: captureExecutionSnapshot(execution, clock.now()) };
  }
  execution.nodeStatusesById = transitionNodeStatus(execution.nodeStatusesById, next!, "READY");
  execution.run = setCurrentNodeId(execution.run, next);
  const latestSnapshot = captureExecutionSnapshot(execution, clock.now());
  return runLoop({ runId: execution.run.runId, plan, registry, clock, maxSteps: request.options?.maxSteps ?? Object.keys(plan.nodesById).length + DEFAULT_MAX_STEPS_ALLOWANCE, reliability: resolved.reliability, execution, latestSnapshot, currentNodeId: next! });
}

async function runLoop(params: { runId: ExecuteWorkflowRequest["runId"]; plan: ExecuteWorkflowRequest["plan"]; registry: ExecuteWorkflowRequest["registry"]; clock: RuntimeClock; maxSteps: number; reliability: ResolvedReliability; execution: RuntimeExecutionState; latestSnapshot: RuntimeExecutionSnapshot; currentNodeId: NodeId }): Promise<WorkflowExecutionResult> {
  const { runId, plan, registry, clock, maxSteps, reliability } = params;
  let { execution, latestSnapshot, currentNodeId } = params;
  let { run, state, nodeStatusesById, step, history } = execution;
  const terminalNodeIds = new Set(plan.terminalNodeIds);

  /** Commits a terminal Run failure from the *last safe boundary* (`execution` as currently committed) and captures its snapshot. Used by every failure path that has not itself already advanced `execution`. */
  function fail(failure: RuntimeFailure): WorkflowExecutionResult {
    run = setCurrentNodeId(transitionRunRecord(run, "FAILED", clock.now()), undefined);
    execution = { ...execution, run };
    latestSnapshot = captureExecutionSnapshot(execution, clock.now());
    return { ok: false, failure, execution, latestSnapshot };
  }

  for (;;) {
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
    // returns at most one accepted outcome; only this loop commits it.
    const outcome = await executeNodeAttempts({ runId, node, executor, state, step, policy: reliability.policyFor(node.id), sleeper: reliability.sleeper });
    const attemptEvidence = { attemptCount: outcome.attemptCount, ...(outcome.attemptFailures.length > 0 ? { attemptFailures: outcome.attemptFailures } : {}) };

    if (outcome.kind === "failure") {
      // No state patch is ever applied from a failed, invalid, or timed-out
      // attempt — the revision before/after this record are identical.
      nodeStatusesById = transitionNodeStatus(nodeStatusesById, node.id, "FAILED");
      history = [...history, { nodeId: node.id, kind: node.kind, step, status: "FAILED", stateRevisionBefore: state.revision, stateRevisionAfter: state.revision, ...attemptEvidence }];
      execution = { run, state, nodeStatusesById, step, history };
      return fail(outcome.failure);
    }

    if (outcome.kind === "wait") {
      nodeStatusesById = transitionNodeStatus(nodeStatusesById, node.id, "WAITING");
      run = transitionRunRecord(run, "WAITING_FOR_APPROVAL", clock.now());
      execution = { run, state, nodeStatusesById, step, history, wait: { ...outcome.wait, nodeId: node.id } };
      latestSnapshot = captureExecutionSnapshot(execution, clock.now());
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

    if (terminalNodeIds.has(node.id)) {
      run = setCurrentNodeId(transitionRunRecord(run, "COMPLETED", clock.now()), undefined);
      execution = { run, state, nodeStatusesById, step, history };
      latestSnapshot = captureExecutionSnapshot(execution, clock.now());
      const output = outcome.output;
      return { ok: true, execution, latestSnapshot, ...(output !== undefined ? { output } : {}) };
    }

    // Preflight guarantees exactly one outgoing edge for every non-terminal node.
    const nextEdge = plan.outgoingEdgesByNode[node.id]?.[0];
    if (nextEdge === undefined) {
      execution = { run, state, nodeStatusesById, step, history };
      return fail({ code: "RUNTIME_PREFLIGHT_FAILED", message: `Non-terminal node "${node.id}" has no outgoing edge mid-execution.`, nodeId: node.id, step });
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
      });
    }
    nodeStatusesById = transitionNodeStatus(nodeStatusesById, currentNodeId, "READY");
    run = setCurrentNodeId(run, currentNodeId);

    execution = { run, state, nodeStatusesById, step, history };
    latestSnapshot = captureExecutionSnapshot(execution, clock.now());
  }
}
