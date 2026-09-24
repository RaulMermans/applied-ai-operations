import { createNodeRegistry } from "./registry.js";
import type { NodeExecutor, NodeRegistry } from "./types.js";

/**
 * The generic, framework-neutral completion executor for `final_output`
 * nodes: it returns the current `RunState.values` as the workflow's final
 * output and proposes no state patch. This is deliberately the smallest
 * possible completion mechanism — no field-selection DSL, no templating, no
 * response rendering — see `docs/architecture/runtime-v1.md` for why.
 */
export const finalOutputExecutor: NodeExecutor = {
  kind: "final_output",
  async execute(context) {
    return { output: context.state.values };
  },
};

/**
 * Builds the only registry Runtime V1 wires up automatically. It contains
 * exactly one genuinely canonical, safe executor (`final_output`) — model,
 * agent, tool, approval, and evaluator executors are deliberately absent
 * until their dedicated implementations exist; a workflow that reaches one
 * of those node kinds fails preflight with `NODE_EXECUTOR_NOT_FOUND` rather
 * than falling through to a fake executor that pretends to succeed.
 */
export function createRuntimeV1Registry(): NodeRegistry {
  const registry = createNodeRegistry();
  registry.register(finalOutputExecutor);
  return registry;
}
