import type { CompiledWorkflowPlan } from "@aao/workflow-dsl";
import type { NodeRegistry, RuntimeFailure } from "./types.js";

/**
 * Runtime V1 preflight: deterministic compatibility checks that must all
 * pass *before* the first node executes. A `CompiledWorkflowPlan` being
 * compiler-valid does not mean Runtime V1 can execute it — see
 * `docs/architecture/runtime-v1.md` for the "workflow valid ≠ runtime
 * supports every feature" distinction this function enforces. Checks run in
 * a fixed order and this function returns the *first* failure found, since
 * every one of them must independently block all execution — there is no
 * value in collecting multiple preflight failures the way semantic
 * validation does, because none of them can be fixed by workflow authors
 * without a Runtime capability change.
 *
 * Order:
 * 1. Compiled plan integrity — cheap defensive checks that the plan is
 *    internally consistent (entry node resolvable, indexes complete, routing
 *    arity matches compiler invariants). The compiler already guarantees
 *    this for a real compiled plan; this protects the Runtime from a
 *    manually constructed or corrupted plan that nonetheless passed the
 *    schema check in `runtime-input-validation.ts`.
 * 2. Conditional routing — Runtime V1 does not evaluate `Edge.condition`.
 * 3. Registered node kinds — every node kind that may execute must have a
 *    registered executor.
 */
export function runPreflight(plan: CompiledWorkflowPlan, registry: NodeRegistry): RuntimeFailure | undefined {
  const integrityFailure = checkPlanIntegrity(plan);
  if (integrityFailure) return integrityFailure;

  const conditionalFailure = checkConditionalRouting(plan);
  if (conditionalFailure) return conditionalFailure;

  // Only meaningful once no conditional edge exists: a compiler-valid
  // conditional plan may have several outgoing edges on one node (the
  // compiler's own AMBIGUOUS_ROUTING / CONDITIONAL_ROUTE_WITHOUT_DEFAULT
  // checks already govern that shape), which is a Runtime V1 *capability*
  // limitation rejected above, not a corrupted plan. Once conditions are
  // known to be entirely absent, Runtime V1's own routing model requires
  // exactly one outgoing edge per non-terminal node — checked here as a
  // defensive guard against a manually corrupted plan the compiler never
  // actually produced.
  const arityFailure = checkUnconditionalRoutingArity(plan);
  if (arityFailure) return arityFailure;

  const executorFailure = checkExecutorsRegistered(plan, registry);
  if (executorFailure) return executorFailure;

  return undefined;
}

function checkPlanIntegrity(plan: CompiledWorkflowPlan): RuntimeFailure | undefined {
  const entryNode = plan.nodesById[plan.entryNodeId];
  if (entryNode === undefined) {
    return { code: "RUNTIME_PREFLIGHT_FAILED", message: `entryNodeId "${plan.entryNodeId}" does not resolve to a node in nodesById.` };
  }

  for (const nodeId of Object.keys(plan.nodesById)) {
    const outgoing = plan.outgoingEdgesByNode[nodeId];
    const incoming = plan.incomingEdgesByNode[nodeId];
    if (outgoing === undefined || incoming === undefined) {
      return { code: "RUNTIME_PREFLIGHT_FAILED", message: `Node "${nodeId}" is missing an edge index entry.`, nodeId };
    }
  }

  const terminalIds = new Set(plan.terminalNodeIds);
  for (const nodeId of Object.keys(plan.nodesById)) {
    const outgoingCount = plan.outgoingEdgesByNode[nodeId]?.length ?? 0;
    const isTerminal = terminalIds.has(nodeId);

    if (isTerminal && outgoingCount !== 0) {
      return { code: "RUNTIME_PREFLIGHT_FAILED", message: `Terminal node "${nodeId}" has outgoing edges.`, nodeId };
    }
    if (!isTerminal && outgoingCount === 0) {
      return { code: "RUNTIME_PREFLIGHT_FAILED", message: `Non-terminal node "${nodeId}" has no outgoing edge.`, nodeId };
    }
  }

  return undefined;
}

function checkUnconditionalRoutingArity(plan: CompiledWorkflowPlan): RuntimeFailure | undefined {
  const terminalIds = new Set(plan.terminalNodeIds);
  for (const [nodeId, node] of Object.entries(plan.nodesById)) {
    if (terminalIds.has(nodeId)) continue;
    const outgoingCount = plan.outgoingEdgesByNode[nodeId]?.length ?? 0;
    if (outgoingCount !== 1) {
      return {
        code: "RUNTIME_PREFLIGHT_FAILED",
        message: `Non-terminal node "${nodeId}" (kind "${node.kind}") must have exactly one outgoing edge for Runtime V1 unconditional routing; found ${outgoingCount}.`,
        nodeId,
      };
    }
  }
  return undefined;
}

function checkConditionalRouting(plan: CompiledWorkflowPlan): RuntimeFailure | undefined {
  for (const edges of Object.values(plan.outgoingEdgesByNode)) {
    for (const edge of edges) {
      if (edge.condition !== undefined) {
        return {
          code: "CONDITIONAL_ROUTING_UNSUPPORTED",
          message: `Runtime V1 does not evaluate edge conditions. Edge "${edge.sourceNodeId}" -> "${edge.targetNodeId}" has a condition.`,
          nodeId: edge.sourceNodeId,
        };
      }
    }
  }
  return undefined;
}

function checkExecutorsRegistered(plan: CompiledWorkflowPlan, registry: NodeRegistry): RuntimeFailure | undefined {
  for (const node of Object.values(plan.nodesById)) {
    if (!registry.has(node.kind)) {
      return {
        code: "NODE_EXECUTOR_NOT_FOUND",
        message: `No executor is registered for node kind "${node.kind}" (node "${node.id}").`,
        nodeId: node.id,
      };
    }
  }
  return undefined;
}
