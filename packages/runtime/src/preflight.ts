import type { EdgeDefinition } from "@aao/contracts";
import { canonicalJsonStringify } from "@aao/contracts";
import type { CompiledWorkflowPlan } from "@aao/workflow-dsl";
import type { NodePreflightResult, NodeRegistry, RuntimeFailure } from "./types.js";

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
 *    internally consistent before any index on it is trusted: every
 *    `nodesById` key matches the id of the node it stores, `entryNodeId` and
 *    every `terminalNodeId` resolve to an existing node, every outgoing
 *    edge's `sourceNodeId` matches the index it is filed under (and every
 *    incoming edge's `targetNodeId` matches its own index), every edge's
 *    source/target resolve to existing nodes, the two edge indexes represent
 *    the same edge set, and routing arity matches compiler invariants. The
 *    compiler already guarantees all of this for a real compiled plan; this
 *    protects the Runtime from a manually constructed or corrupted plan that
 *    nonetheless passed the schema check in `runtime-input-validation.ts`.
 *    This does not re-run reachability, cycle, or condition-structure
 *    validation — those are the compiler's job (see `@aao/workflow-dsl`),
 *    not the Runtime's.
 * 2. Conditional routing — Runtime V1 does not evaluate `Edge.condition`.
 * 3. Registered node kinds — every node kind that may execute must have a
 *    registered executor.
 * 4. Node-specific static config — every registered executor that declares
 *    the optional `validateConfig` hook validates each of its nodes'
 *    `config`, so a malformed specialized node fails here rather than after
 *    earlier nodes have already executed.
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

  const configFailure = checkNodeConfigs(plan, registry);
  if (configFailure) return configFailure;

  return undefined;
}

function checkPlanIntegrity(plan: CompiledWorkflowPlan): RuntimeFailure | undefined {
  // `nodesById` keys are the Runtime's only way to resolve a NodeId to a
  // node; if a key ever disagreed with the node it stores, every later
  // lookup by that key would silently return the wrong node.
  for (const [nodeId, node] of Object.entries(plan.nodesById)) {
    if (node.id !== nodeId) {
      return {
        code: "RUNTIME_PREFLIGHT_FAILED",
        message: `nodesById key "${nodeId}" does not match its node's id "${node.id}".`,
        nodeId,
      };
    }
  }

  const entryNode = plan.nodesById[plan.entryNodeId];
  if (entryNode === undefined) {
    return { code: "RUNTIME_PREFLIGHT_FAILED", message: `entryNodeId "${plan.entryNodeId}" does not resolve to a node in nodesById.` };
  }

  for (const terminalNodeId of plan.terminalNodeIds) {
    if (plan.nodesById[terminalNodeId] === undefined) {
      return {
        code: "RUNTIME_PREFLIGHT_FAILED",
        message: `terminalNodeId "${terminalNodeId}" does not resolve to a node in nodesById.`,
        nodeId: terminalNodeId,
      };
    }
  }

  for (const nodeId of Object.keys(plan.nodesById)) {
    const outgoing = plan.outgoingEdgesByNode[nodeId];
    const incoming = plan.incomingEdgesByNode[nodeId];
    if (outgoing === undefined || incoming === undefined) {
      return { code: "RUNTIME_PREFLIGHT_FAILED", message: `Node "${nodeId}" is missing an edge index entry.`, nodeId };
    }

    for (const edge of outgoing) {
      if (edge.sourceNodeId !== nodeId) {
        return {
          code: "RUNTIME_PREFLIGHT_FAILED",
          message: `outgoingEdgesByNode["${nodeId}"] contains an edge whose sourceNodeId is "${edge.sourceNodeId}", not "${nodeId}".`,
          nodeId,
        };
      }
      if (plan.nodesById[edge.sourceNodeId] === undefined || plan.nodesById[edge.targetNodeId] === undefined) {
        return {
          code: "RUNTIME_PREFLIGHT_FAILED",
          message: `Edge "${edge.sourceNodeId}" -> "${edge.targetNodeId}" in outgoingEdgesByNode["${nodeId}"] references a node that does not exist.`,
          nodeId,
        };
      }
    }

    for (const edge of incoming) {
      if (edge.targetNodeId !== nodeId) {
        return {
          code: "RUNTIME_PREFLIGHT_FAILED",
          message: `incomingEdgesByNode["${nodeId}"] contains an edge whose targetNodeId is "${edge.targetNodeId}", not "${nodeId}".`,
          nodeId,
        };
      }
      if (plan.nodesById[edge.sourceNodeId] === undefined || plan.nodesById[edge.targetNodeId] === undefined) {
        return {
          code: "RUNTIME_PREFLIGHT_FAILED",
          message: `Edge "${edge.sourceNodeId}" -> "${edge.targetNodeId}" in incomingEdgesByNode["${nodeId}"] references a node that does not exist.`,
          nodeId,
        };
      }
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

  // Runs last: every check above anchors a failure to a specific node and is
  // more actionable than this whole-plan cross-check, so a plan that trips
  // both reports the more specific failure first.
  const edgeSetFailure = checkOutgoingIncomingEdgeSetsMatch(plan);
  if (edgeSetFailure) return edgeSetFailure;

  return undefined;
}

/**
 * Defensive cross-check, not a re-run of the compiler: the compiler always
 * pushes the same edge object into both indexes (see
 * `@aao/workflow-dsl`'s `compiler.ts`), so for a real compiled plan this can
 * never fail. It exists only to catch a manually corrupted or partially
 * rebuilt plan where the two indexes have drifted apart — counted by a
 * simple, deterministic structural key rather than a general deep-equality
 * or graph-diff routine.
 */
function checkOutgoingIncomingEdgeSetsMatch(plan: CompiledWorkflowPlan): RuntimeFailure | undefined {
  const outgoingCounts = countEdgeKeys(Object.values(plan.outgoingEdgesByNode).flat());
  const incomingCounts = countEdgeKeys(Object.values(plan.incomingEdgesByNode).flat());

  const sameSize = outgoingCounts.size === incomingCounts.size;
  const sameCounts = sameSize && [...outgoingCounts].every(([key, count]) => incomingCounts.get(key) === count);
  if (!sameCounts) {
    return {
      code: "RUNTIME_PREFLIGHT_FAILED",
      message: "outgoingEdgesByNode and incomingEdgesByNode do not represent the same edge set.",
    };
  }
  return undefined;
}

function countEdgeKeys(edges: EdgeDefinition[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const edge of edges) {
    // Canonical (key-sorted) JSON, not raw JSON.stringify: two structurally
    // equal conditions with keys in a different order (e.g. {"a":1,"b":2} vs
    // {"b":2,"a":1}) must fingerprint identically here, matching
    // @aao/workflow-dsl's own duplicate-edge fingerprinting in
    // semantic-validator.ts (see ADR-010, Sprint 4 carryover).
    const key = `${edge.sourceNodeId}=>${edge.targetNodeId}::${canonicalJsonStringify(edge.condition ?? null)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
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

function checkNodeConfigs(plan: CompiledWorkflowPlan, registry: NodeRegistry): RuntimeFailure | undefined {
  for (const node of Object.values(plan.nodesById)) {
    const executor = registry.get(node.kind);
    if (executor?.validateConfig === undefined) continue;

    let verdict: NodePreflightResult | undefined;
    try {
      verdict = executor.validateConfig({ node: JSON.parse(JSON.stringify(node)) as typeof node });
    } catch {
      // Deliberately generic, like a throwing executor at execution time:
      // the thrown value is never exposed.
      verdict = undefined;
    }

    if (verdict?.ok === true) continue;
    const issues = verdict !== undefined && Array.isArray(verdict.issues) && verdict.issues.every((issue) => typeof issue === "string") ? verdict.issues : undefined;
    return {
      code: "RUNTIME_PREFLIGHT_FAILED",
      message: `Node "${node.id}" (kind "${node.kind}") has invalid static configuration.`,
      nodeId: node.id,
      ...(issues !== undefined ? { details: { issues } } : {}),
    };
  }
  return undefined;
}
