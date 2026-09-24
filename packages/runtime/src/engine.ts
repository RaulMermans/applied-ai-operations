import type { JsonValue, RunState } from "@aao/contracts";
import { validateNodeExecutionResult } from "./node-result-validation.js";
import { runPreflight } from "./preflight.js";
import { validateRuntimeInput } from "./runtime-input-validation.js";
import { applyStatePatch, cloneRunState } from "./state.js";
import type { ExecuteWorkflowRequest, NodeExecutionRecord, RuntimeFailure, WorkflowExecutionResult } from "./types.js";

/**
 * The bounded allowance added on top of a plan's node count when computing
 * the default `maxSteps` ceiling. Workflow Compiler V1 already rejects
 * cycles, so this exists purely as protection against a corrupted plan or a
 * future Runtime implementation bug — not as a feature workflows are
 * expected to rely on.
 */
const DEFAULT_MAX_STEPS_ALLOWANCE = 5;

/**
 * Executes a `CompiledWorkflowPlan` end to end: preflight, then a
 * deterministic sequential walk from `entryNodeId` to a terminal
 * (`final_output`) node, applying each executor's validated state patch and
 * following the plan's single unconditional outgoing edge at every step. See
 * `docs/architecture/runtime-v1.md` for the full pipeline this function
 * implements and what Runtime V1 deliberately does not support yet
 * (conditional routing, retries, persistence, model/tool/agent/approval
 * execution).
 */
export async function executeWorkflow(request: ExecuteWorkflowRequest): Promise<WorkflowExecutionResult> {
  const inputFailure = validateRuntimeInput(request);
  if (inputFailure) return { ok: false, failure: inputFailure };

  const { runId, plan, registry } = request;

  const preflightFailure = runPreflight(plan, registry);
  if (preflightFailure) return { ok: false, failure: preflightFailure };

  const maxSteps = request.options?.maxSteps ?? Object.keys(plan.nodesById).length + DEFAULT_MAX_STEPS_ALLOWANCE;

  let state: RunState = cloneRunState(request.initialState);
  let currentNodeId = plan.entryNodeId;
  const history: NodeExecutionRecord[] = [];
  let output: JsonValue | undefined;
  let step = 0;

  const terminalNodeIds = new Set(plan.terminalNodeIds);

  for (;;) {
    step += 1;
    if (step > maxSteps) {
      const failure: RuntimeFailure = {
        code: "MAX_STEPS_EXCEEDED",
        message: `Runtime V1 execution exceeded the maximum of ${maxSteps} step(s).`,
        step,
        details: { maxSteps },
      };
      return { ok: false, failure };
    }

    // Guaranteed to resolve: preflight verified every plan node has both an
    // executor and consistent routing before this loop began.
    const node = plan.nodesById[currentNodeId];
    if (node === undefined) {
      return {
        ok: false,
        failure: { code: "RUNTIME_PREFLIGHT_FAILED", message: `Node "${currentNodeId}" does not resolve mid-execution.`, nodeId: currentNodeId, step },
      };
    }
    const executor = registry.get(node.kind);
    if (executor === undefined) {
      return {
        ok: false,
        failure: { code: "NODE_EXECUTOR_NOT_FOUND", message: `No executor registered for node kind "${node.kind}" (node "${node.id}").`, nodeId: node.id, step },
      };
    }

    let rawResult: unknown;
    try {
      rawResult = await executor.execute({ runId, node: cloneNodeDefinition(node), state: cloneRunState(state), step });
    } catch {
      // Deliberately generic: the thrown value (Error.message, stack, or any
      // other shape) is never exposed here. It may originate from a
      // company-specific or third-party executor and could contain secrets
      // or internal implementation detail; the public failure carries only
      // safe, deterministic metadata (code, a fixed message, nodeId, step).
      const failure: RuntimeFailure = {
        code: "NODE_EXECUTION_FAILED",
        message: `Node "${node.id}" (kind "${node.kind}") threw during execution.`,
        nodeId: node.id,
        step,
      };
      return { ok: false, failure };
    }

    const validated = validateNodeExecutionResult(rawResult);
    if (!validated.ok) {
      const failure: RuntimeFailure = { code: validated.code, message: `Node "${node.id}": ${validated.message}`, nodeId: node.id, step };
      return { ok: false, failure };
    }

    const stateRevisionBefore = state.revision;
    state = applyStatePatch(state, validated.result.statePatch);
    const stateRevisionAfter = state.revision;

    history.push({
      nodeId: node.id,
      kind: node.kind,
      step,
      status: "SUCCEEDED",
      ...(validated.result.output !== undefined ? { output: validated.result.output } : {}),
      stateRevisionBefore,
      stateRevisionAfter,
    });

    if (terminalNodeIds.has(node.id)) {
      output = validated.result.output;
      break;
    }

    // Preflight guarantees exactly one outgoing edge for every non-terminal node.
    const nextEdge = plan.outgoingEdgesByNode[node.id]?.[0];
    if (nextEdge === undefined) {
      return {
        ok: false,
        failure: { code: "RUNTIME_PREFLIGHT_FAILED", message: `Non-terminal node "${node.id}" has no outgoing edge mid-execution.`, nodeId: node.id, step },
      };
    }
    currentNodeId = nextEdge.targetNodeId;
  }

  return { ok: true, run: { runId, status: "COMPLETED", state, output, history } };
}

function cloneNodeDefinition<T>(node: T): T {
  return JSON.parse(JSON.stringify(node)) as T;
}
