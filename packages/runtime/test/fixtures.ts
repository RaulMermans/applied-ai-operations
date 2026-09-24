import type { EdgeDefinition, JsonObject, NodeDefinition, RunState, Workflow } from "@aao/contracts";
import { compileWorkflow } from "@aao/workflow-dsl";
import type { CompiledWorkflowPlan } from "@aao/workflow-dsl";
import { finalOutputExecutor } from "../src/default-registry.js";
import { createNodeRegistry } from "../src/registry.js";
import type { ExecuteWorkflowRequest, NodeExecutor, NodeRegistry } from "../src/types.js";

/** Builds a schema-valid Workflow shell, matching the pattern @aao/workflow-dsl's own fixtures use. */
export function buildWorkflow(overrides: { entryNodeId: string; nodes: NodeDefinition[]; edges: EdgeDefinition[]; id?: string }): Workflow {
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

/** Compiles a Workflow and asserts success, for tests that only care about the resulting plan. */
export function compileOrThrow(workflow: Workflow): CompiledWorkflowPlan {
  const result = compileWorkflow(workflow);
  if (!result.ok) throw new Error(`fixture workflow failed to compile: ${JSON.stringify(result.diagnostics)}`);
  return result.plan;
}

export const minimalPlan: CompiledWorkflowPlan = compileOrThrow(
  buildWorkflow({
    entryNodeId: "intake",
    nodes: [
      { id: "intake", kind: "deterministic", config: {} },
      { id: "final", kind: "final_output", config: {} },
    ],
    edges: [{ sourceNodeId: "intake", targetNodeId: "final" }],
  }),
);

export function buildRunState(runId: string, values: JsonObject = {}): RunState {
  return { runId, revision: 0, values };
}

/**
 * A test/fixture-only deterministic executor: it reads a literal
 * `statePatch` straight out of `node.config` and proposes it unchanged. This
 * is intentionally generic (no business semantics like "qualify_lead") — see
 * docs/architecture/runtime-v1.md's "Deterministic Node Semantics" note.
 * Real deployments register their own executors; this one exists only to
 * exercise the Runtime in tests and the example script.
 */
export const literalPatchExecutor: NodeExecutor = {
  kind: "deterministic",
  async execute(context) {
    const config = context.node.config as { statePatch?: JsonObject };
    return config.statePatch !== undefined ? { statePatch: config.statePatch } : {};
  },
};

export function createTestRegistry(...executors: NodeExecutor[]): NodeRegistry {
  const registry = createNodeRegistry();
  for (const executor of executors) registry.register(executor);
  return registry;
}

export function buildRequest(overrides: Partial<ExecuteWorkflowRequest> & { runId: string }): ExecuteWorkflowRequest {
  return {
    runId: overrides.runId,
    plan: overrides.plan ?? minimalPlan,
    initialState: overrides.initialState ?? buildRunState(overrides.runId),
    registry: overrides.registry ?? createTestRegistry(literalPatchExecutor, finalOutputExecutor),
    ...(overrides.options !== undefined ? { options: overrides.options } : {}),
  };
}
