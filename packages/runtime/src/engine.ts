import type { NodeId, RunRecord, RunState } from "@aao/contracts";
import { createSystemClock, type RuntimeClock } from "./clock.js";
import { captureExecutionSnapshot, type RuntimeExecutionSnapshot } from "./execution-snapshot.js";
import { initializeNodeStatuses, transitionNodeStatus, type NodeStatusMap } from "./node-lifecycle.js";
import { validateNodeExecutionResult } from "./node-result-validation.js";
import { runPreflight } from "./preflight.js";
import { createRunRecord, setCurrentNodeId, transitionRunRecord } from "./run-lifecycle.js";
import { validateRuntimeInput } from "./runtime-input-validation.js";
import { applyStatePatch, cloneRunState } from "./state.js";
import type { ExecuteWorkflowRequest, NodeExecutionRecord, RuntimeExecutionState, RuntimeFailure, WorkflowExecutionResult } from "./types.js";

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
 * FAILED`), maintains authoritative Node lifecycle for every plan Node, and
 * captures a safe `RuntimeExecutionSnapshot` at every safe execution
 * boundary. See `docs/architecture/runtime-state-management.md` and
 * ADR-010 for the full state model this function implements, and
 * `docs/architecture/runtime-v1.md` for what Runtime V1 deliberately does
 * not support yet (conditional routing, retries, persistence,
 * model/tool/agent/approval execution, resume).
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

  let currentNodeId: NodeId = plan.entryNodeId;
  nodeStatusesById = transitionNodeStatus(nodeStatusesById, currentNodeId, "READY");
  run = setCurrentNodeId(run, currentNodeId);

  let state: RunState = cloneRunState(request.initialState);
  let history: NodeExecutionRecord[] = [];
  let step = 0;

  let execution: RuntimeExecutionState = { run, state, nodeStatusesById, step, history };
  let latestSnapshot: RuntimeExecutionSnapshot = captureExecutionSnapshot(execution, clock.now());

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

    let rawResult: unknown;
    try {
      rawResult = await executor.execute({ runId, node: cloneNodeDefinition(node), state: cloneRunState(state), step });
    } catch {
      // Deliberately generic: the thrown value (Error.message, stack, or any
      // other shape) is never exposed here — see engine-safety tests. Only
      // safe, deterministic metadata reaches the public failure.
      nodeStatusesById = transitionNodeStatus(nodeStatusesById, node.id, "FAILED");
      history = [...history, { nodeId: node.id, kind: node.kind, step, status: "FAILED", stateRevisionBefore: state.revision, stateRevisionAfter: state.revision }];
      execution = { run, state, nodeStatusesById, step, history };
      return fail({ code: "NODE_EXECUTION_FAILED", message: `Node "${node.id}" (kind "${node.kind}") threw during execution.`, nodeId: node.id, step });
    }

    const validated = validateNodeExecutionResult(rawResult);
    if (!validated.ok) {
      // No state patch is ever applied from a result that failed validation
      // — the revision before/after this record are identical.
      nodeStatusesById = transitionNodeStatus(nodeStatusesById, node.id, "FAILED");
      history = [...history, { nodeId: node.id, kind: node.kind, step, status: "FAILED", stateRevisionBefore: state.revision, stateRevisionAfter: state.revision }];
      execution = { run, state, nodeStatusesById, step, history };
      return fail({ code: validated.code, message: `Node "${node.id}": ${validated.message}`, nodeId: node.id, step });
    }

    if (!validated.result.ok) {
      // An expected, executor-reported failure: the result was well-formed,
      // so only its bounded { namespace, code } is carried through — as
      // opaque subordinate causality the Runtime never interprets. No patch
      // is applied, exactly like a throw.
      const executorFailure = validated.result.failure;
      nodeStatusesById = transitionNodeStatus(nodeStatusesById, node.id, "FAILED");
      history = [...history, { nodeId: node.id, kind: node.kind, step, status: "FAILED", stateRevisionBefore: state.revision, stateRevisionAfter: state.revision }];
      execution = { run, state, nodeStatusesById, step, history };
      return fail({
        code: "NODE_EXECUTION_FAILED",
        message: `Node "${node.id}" (kind "${node.kind}") reported an executor failure.`,
        nodeId: node.id,
        step,
        executorFailure: { ...executorFailure },
      });
    }

    const stateRevisionBefore = state.revision;
    state = applyStatePatch(state, validated.result.statePatch);
    const stateRevisionAfter = state.revision;

    nodeStatusesById = transitionNodeStatus(nodeStatusesById, node.id, "SUCCEEDED");
    history = [
      ...history,
      {
        nodeId: node.id,
        kind: node.kind,
        step,
        status: "SUCCEEDED",
        ...(validated.result.output !== undefined ? { output: validated.result.output } : {}),
        stateRevisionBefore,
        stateRevisionAfter,
      },
    ];

    if (terminalNodeIds.has(node.id)) {
      run = setCurrentNodeId(transitionRunRecord(run, "COMPLETED", clock.now()), undefined);
      execution = { run, state, nodeStatusesById, step, history };
      latestSnapshot = captureExecutionSnapshot(execution, clock.now());
      const output = validated.result.output;
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

function cloneNodeDefinition<T>(node: T): T {
  return JSON.parse(JSON.stringify(node)) as T;
}
