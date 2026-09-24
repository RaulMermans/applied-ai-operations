// @aao/runtime — the first production execution engine for a
// `CompiledWorkflowPlan`. See docs/architecture/runtime-v1.md and ADR-009
// for the pipeline and scope this package implements: a Node Registry,
// runtime preflight, sequential deterministic execution over unconditional
// routing, explicit state-patch application, and a small structured failure
// taxonomy. Consumes @aao/contracts and @aao/workflow-dsl as canonical
// sources of truth; never parses workflow source, never redefines Node
// kinds, and performs no model/tool/agent/approval execution or
// persistence.

export type {
  NodeExecutor,
  NodeExecutionContext,
  NodeExecutionResult,
  NodeRegistry,
  RuntimeOptions,
  ExecuteWorkflowRequest,
  NodeExecutionRecord,
  RuntimeRunResult,
  RuntimeFailureCode,
  RuntimeFailure,
  WorkflowExecutionResult,
} from "./types.js";

export { createNodeRegistry } from "./registry.js";
export { createRuntimeV1Registry, finalOutputExecutor } from "./default-registry.js";
export { applyStatePatch, cloneRunState } from "./state.js";
export { runPreflight } from "./preflight.js";
export { validateRuntimeInput } from "./runtime-input-validation.js";
export { validateNodeExecutionResult } from "./node-result-validation.js";
export { isJsonSafe } from "./json-safety.js";
export { executeWorkflow } from "./engine.js";
