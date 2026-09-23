import type { EdgeDefinition, NodeDefinition, Workflow } from "@aao/contracts";

/** Builds a schema-valid Workflow shell so tests only need to override nodes/edges/entry. */
export function buildWorkflow(overrides: {
  entryNodeId: string;
  nodes: NodeDefinition[];
  edges: EdgeDefinition[];
  id?: string;
}): Workflow {
  return {
    schemaVersion: 1,
    id: overrides.id ?? "test.workflow",
    version: "1.0.0",
    name: "Test workflow",
    entryNodeId: overrides.entryNodeId,
    nodes: overrides.nodes,
    edges: overrides.edges,
  };
}

export const minimalValidWorkflow: Workflow = buildWorkflow({
  entryNodeId: "intake",
  nodes: [
    { id: "intake", kind: "deterministic", config: {} },
    { id: "final", kind: "final_output", config: {} },
  ],
  edges: [{ sourceNodeId: "intake", targetNodeId: "final" }],
});
