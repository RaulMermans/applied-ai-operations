import type { EdgeDefinition, NodeDefinition, NodeId, Workflow } from "@aao/contracts";
import { parseWorkflowSource } from "./parser.js";
import { validateWorkflowSemantics } from "./semantic-validator.js";
import type { CompiledWorkflowPlan, WorkflowCompileResult, WorkflowSourceFormat } from "./types.js";

/**
 * Validates a canonical Workflow's graph semantics and, if it passes,
 * compiles it into a framework-neutral, JSON-safe CompiledWorkflowPlan. The
 * caller's `workflow` object is never mutated — the plan is built from a
 * deep JSON clone, so the two are fully independent afterward.
 */
export function compileWorkflow(workflow: Workflow): WorkflowCompileResult {
  const diagnostics = validateWorkflowSemantics(workflow);
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  const clonedWorkflow = deepCloneJson(workflow);

  const nodesById: Record<NodeId, NodeDefinition> = {};
  const outgoingEdgesByNode: Record<NodeId, EdgeDefinition[]> = {};
  const incomingEdgesByNode: Record<NodeId, EdgeDefinition[]> = {};
  const terminalNodeIds: NodeId[] = [];

  for (const node of clonedWorkflow.nodes) {
    if (node.id in nodesById) continue; // guarded by validateWorkflowSemantics; defensive only
    nodesById[node.id] = node;
    outgoingEdgesByNode[node.id] = [];
    incomingEdgesByNode[node.id] = [];
    if (node.kind === "final_output") terminalNodeIds.push(node.id);
  }

  for (const edge of clonedWorkflow.edges) {
    outgoingEdgesByNode[edge.sourceNodeId]?.push(edge);
    incomingEdgesByNode[edge.targetNodeId]?.push(edge);
  }

  const plan: CompiledWorkflowPlan = {
    schemaVersion: 1,
    workflow: clonedWorkflow,
    entryNodeId: clonedWorkflow.entryNodeId,
    nodesById,
    outgoingEdgesByNode,
    incomingEdgesByNode,
    terminalNodeIds,
  };

  return { ok: true, plan };
}

/** Source -> parse -> canonical schema -> semantic validation -> compile, in one call. */
export function compileWorkflowSource(source: string, format: WorkflowSourceFormat): WorkflowCompileResult {
  const parsed = parseWorkflowSource(source, format);
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
  return compileWorkflow(parsed.workflow);
}

function deepCloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
