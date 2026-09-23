import type { EdgeDefinition, NodeDefinition, NodeId, Workflow } from "@aao/contracts";

/**
 * V1 authoring formats. Both compile into the same canonical Workflow
 * representation — see docs/architecture/workflow-dsl.md.
 */
export type WorkflowSourceFormat = "yaml" | "json";

/**
 * Stable, machine-readable diagnostic codes. Keep this list in sync with
 * docs/architecture/workflow-dsl.md, which documents what each one means.
 */
export type WorkflowDiagnosticCode =
  | "PARSE_ERROR"
  | "SCHEMA_VALIDATION_ERROR"
  | "DUPLICATE_NODE_ID"
  | "ENTRY_NODE_NOT_FOUND"
  | "EDGE_SOURCE_NOT_FOUND"
  | "EDGE_TARGET_NOT_FOUND"
  | "DUPLICATE_EDGE"
  | "UNREACHABLE_NODE"
  | "CYCLE_NOT_SUPPORTED"
  | "FINAL_OUTPUT_HAS_OUTGOING_EDGE"
  | "NON_FINAL_TERMINAL_NODE"
  | "AMBIGUOUS_ROUTING"
  | "CONDITIONAL_ROUTE_WITHOUT_DEFAULT";

/**
 * A single deterministic, JSON-safe compiler diagnostic. `path` is a
 * dot-joined pointer into the source object (e.g. "nodes.0.kind") when one is
 * derivable; `nodeId`/`edgeIndex` are populated whenever a diagnostic can be
 * anchored to a specific node or edge.
 */
export interface WorkflowDiagnostic {
  code: WorkflowDiagnosticCode;
  message: string;
  path?: string;
  nodeId?: NodeId;
  edgeIndex?: number;
}

export type WorkflowParseResult = { ok: true; workflow: Workflow } | { ok: false; diagnostics: WorkflowDiagnostic[] };

export type WorkflowCompileResult =
  | { ok: true; plan: CompiledWorkflowPlan }
  | { ok: false; diagnostics: WorkflowDiagnostic[] };

/**
 * The framework-neutral, JSON-safe artifact produced once a Workflow has
 * passed parsing, canonical schema validation, and graph semantic
 * validation. No Map/Set/class instances/functions — every field survives
 * JSON.stringify -> JSON.parse without semantic loss.
 */
export interface CompiledWorkflowPlan {
  schemaVersion: 1;
  workflow: Workflow;
  entryNodeId: NodeId;
  nodesById: Record<NodeId, NodeDefinition>;
  outgoingEdgesByNode: Record<NodeId, EdgeDefinition[]>;
  incomingEdgesByNode: Record<NodeId, EdgeDefinition[]>;
  terminalNodeIds: NodeId[];
}
