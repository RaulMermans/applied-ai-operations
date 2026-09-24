import type { EdgeDefinition, NodeDefinition, NodeId, Workflow } from "@aao/contracts";
import { canonicalJsonStringify } from "./canonical-json.js";
import type { WorkflowDiagnostic } from "./types.js";

/**
 * Graph-level semantic validation over an already schema-valid Workflow.
 * Checks run in a fixed, documented order and every independent violation is
 * collected (not just the first) so callers see the full picture in one
 * pass — see docs/architecture/workflow-dsl.md for the exact ordering and
 * rationale. Never mutates `workflow`.
 */
export function validateWorkflowSemantics(workflow: Workflow): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];

  // 1. Node identity: unique ids. `nodesById` retains only the first
  // occurrence of a duplicated id so every later check has one unambiguous
  // graph to reason about.
  const nodesById = new Map<NodeId, NodeDefinition>();
  for (const node of workflow.nodes) {
    if (nodesById.has(node.id)) {
      diagnostics.push({
        code: "DUPLICATE_NODE_ID",
        message: `Node id "${node.id}" is used by more than one node.`,
        nodeId: node.id,
      });
      continue;
    }
    nodesById.set(node.id, node);
  }

  // 2. Entry node must reference an existing node.
  const entryExists = nodesById.has(workflow.entryNodeId);
  if (!entryExists) {
    diagnostics.push({
      code: "ENTRY_NODE_NOT_FOUND",
      message: `entryNodeId "${workflow.entryNodeId}" does not reference an existing node.`,
      path: "entryNodeId",
    });
  }

  // 3. Edge references. Edges with a missing source and/or target are
  // excluded from every later structural check (reachability, terminal
  // semantics, routing, cycles) so one broken reference cannot cascade into
  // unrelated diagnostics.
  const validEdges: EdgeDefinition[] = [];
  workflow.edges.forEach((edge, index) => {
    const sourceExists = nodesById.has(edge.sourceNodeId);
    const targetExists = nodesById.has(edge.targetNodeId);
    if (!sourceExists) {
      diagnostics.push({
        code: "EDGE_SOURCE_NOT_FOUND",
        message: `Edge ${index} references sourceNodeId "${edge.sourceNodeId}", which does not exist.`,
        path: `edges.${index}.sourceNodeId`,
        edgeIndex: index,
      });
    }
    if (!targetExists) {
      diagnostics.push({
        code: "EDGE_TARGET_NOT_FOUND",
        message: `Edge ${index} references targetNodeId "${edge.targetNodeId}", which does not exist.`,
        path: `edges.${index}.targetNodeId`,
        edgeIndex: index,
      });
    }
    if (sourceExists && targetExists) validEdges.push(edge);
  });

  // 4. Duplicate edges: exact source + target + condition matches. Condition
  // semantics are never evaluated — structural equality (via a canonical,
  // key-sorted JSON form) is used only for duplicate-edge detection, so
  // `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` are treated as the same condition
  // here. Different conditions routing to the same target remain valid.
  const seenEdgeKeys = new Set<string>();
  workflow.edges.forEach((edge, index) => {
    if (!nodesById.has(edge.sourceNodeId) || !nodesById.has(edge.targetNodeId)) return;

    const key = `${edge.sourceNodeId}=>${edge.targetNodeId}::${canonicalJsonStringify(edge.condition ?? null)}`;
    if (seenEdgeKeys.has(key)) {
      diagnostics.push({
        code: "DUPLICATE_EDGE",
        message: `Edge ${index} duplicates an earlier edge from "${edge.sourceNodeId}" to "${edge.targetNodeId}" with an equivalent condition.`,
        path: `edges.${index}`,
        edgeIndex: index,
      });
      return;
    }
    seenEdgeKeys.add(key);
  });

  // Build an outgoing-edge index from valid edges only, reused by
  // reachability, terminal semantics, routing, and cycle detection.
  const outgoingByNode = new Map<NodeId, EdgeDefinition[]>();
  for (const nodeId of nodesById.keys()) outgoingByNode.set(nodeId, []);
  for (const edge of validEdges) {
    outgoingByNode.get(edge.sourceNodeId)?.push(edge);
  }

  // 5. Reachability from entryNodeId. Only meaningful once an entry node is
  // known to exist.
  if (entryExists) {
    const visited = new Set<NodeId>([workflow.entryNodeId]);
    const stack: NodeId[] = [workflow.entryNodeId];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) continue;
      for (const edge of outgoingByNode.get(current) ?? []) {
        if (!visited.has(edge.targetNodeId)) {
          visited.add(edge.targetNodeId);
          stack.push(edge.targetNodeId);
        }
      }
    }
    for (const nodeId of nodesById.keys()) {
      if (!visited.has(nodeId)) {
        diagnostics.push({
          code: "UNREACHABLE_NODE",
          message: `Node "${nodeId}" is not reachable from entryNodeId "${workflow.entryNodeId}".`,
          nodeId,
        });
      }
    }
  }

  // 6. Terminal semantics: final_output nodes terminate explicitly and must
  // have no outgoing edges; every other node must route somewhere.
  for (const [nodeId, node] of nodesById) {
    const outgoing = outgoingByNode.get(nodeId) ?? [];
    if (node.kind === "final_output") {
      if (outgoing.length > 0) {
        diagnostics.push({
          code: "FINAL_OUTPUT_HAS_OUTGOING_EDGE",
          message: `final_output node "${nodeId}" must not have outgoing edges.`,
          nodeId,
        });
      }
    } else if (outgoing.length === 0) {
      diagnostics.push({
        code: "NON_FINAL_TERMINAL_NODE",
        message: `Node "${nodeId}" has no outgoing edges but is not a final_output node.`,
        nodeId,
      });
    }
  }

  // 7. Routing semantics: a node with a single unconditional outgoing edge is
  // a valid simple route, but a single *conditional* outgoing edge has no
  // fallback and is rejected — a conditional edge can, structurally, fail to
  // match at runtime, so at least one unconditional default is required
  // whenever any outgoing edge is conditional. A node with multiple outgoing
  // edges must have at most one unconditional edge, acting as the
  // default/fallback.
  for (const nodeId of nodesById.keys()) {
    const outgoing = outgoingByNode.get(nodeId) ?? [];
    if (outgoing.length === 0) continue; // covered by terminal semantics above

    const unconditionalCount = outgoing.filter((edge) => edge.condition === undefined).length;

    if (outgoing.length === 1) {
      if (unconditionalCount === 0) {
        diagnostics.push({
          code: "CONDITIONAL_ROUTE_WITHOUT_DEFAULT",
          message: `Node "${nodeId}" has a single conditional outgoing edge and no default (unconditional) route.`,
          nodeId,
        });
      }
      continue;
    }

    if (unconditionalCount > 1) {
      diagnostics.push({
        code: "AMBIGUOUS_ROUTING",
        message: `Node "${nodeId}" has more than one unconditional outgoing edge; routing is ambiguous.`,
        nodeId,
      });
    } else if (unconditionalCount === 0) {
      diagnostics.push({
        code: "CONDITIONAL_ROUTE_WITHOUT_DEFAULT",
        message: `Node "${nodeId}" has multiple conditional outgoing edges but no default (unconditional) route.`,
        nodeId,
      });
    }
  }

  // 8. Cycles: rejected as a Workflow Compiler V1 limitation, not a
  // permanent architecture rule (see ADR-008).
  diagnostics.push(...detectCycles(nodesById, outgoingByNode));

  return diagnostics;
}

/**
 * Iterative (non-recursive, so a large graph cannot overflow the call stack)
 * depth-first traversal over valid edges only, using explicit
 * visiting/done coloring to find back-edges deterministically. Traversal
 * order follows `nodesById`/edge-array order, so the same workflow always
 * reports the same cycle diagnostics in the same order.
 */
function detectCycles(
  nodesById: Map<NodeId, NodeDefinition>,
  outgoingByNode: Map<NodeId, EdgeDefinition[]>,
): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  const state = new Map<NodeId, "visiting" | "done">();
  const reportedEdges = new Set<string>();

  interface Frame {
    nodeId: NodeId;
    edges: EdgeDefinition[];
    index: number;
  }

  for (const startId of nodesById.keys()) {
    if (state.has(startId)) continue;

    state.set(startId, "visiting");
    const frameStack: Frame[] = [{ nodeId: startId, edges: outgoingByNode.get(startId) ?? [], index: 0 }];

    while (frameStack.length > 0) {
      const frame = frameStack[frameStack.length - 1];
      if (frame === undefined) break;

      if (frame.index >= frame.edges.length) {
        state.set(frame.nodeId, "done");
        frameStack.pop();
        continue;
      }

      const edge = frame.edges[frame.index];
      frame.index += 1;
      if (edge === undefined) continue;

      const targetState = state.get(edge.targetNodeId);
      if (targetState === "visiting") {
        const key = `${edge.sourceNodeId}=>${edge.targetNodeId}`;
        if (!reportedEdges.has(key)) {
          reportedEdges.add(key);
          diagnostics.push({
            code: "CYCLE_NOT_SUPPORTED",
            message: `Cycle detected: the edge from "${edge.sourceNodeId}" to "${edge.targetNodeId}" closes a cycle, which Workflow Compiler V1 does not support.`,
            nodeId: edge.targetNodeId,
          });
        }
      } else if (targetState === undefined) {
        state.set(edge.targetNodeId, "visiting");
        frameStack.push({ nodeId: edge.targetNodeId, edges: outgoingByNode.get(edge.targetNodeId) ?? [], index: 0 });
      }
    }
  }

  return diagnostics;
}
