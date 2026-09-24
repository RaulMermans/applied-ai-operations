// @aao/runtime — the first production execution engine for a
// `CompiledWorkflowPlan`, now a *managed* run execution system (Sprint 5;
// see docs/architecture/runtime-v1.md, docs/architecture/runtime-state-management.md,
// and ADR-009/ADR-010). Provides a Node Registry, runtime preflight,
// deterministic execution over unconditional routing, an authoritative Run
// lifecycle, an authoritative Node lifecycle, revisioned state with
// explicit state-patch application, an explicit clock boundary, safe
// execution snapshots, and a small structured failure taxonomy. Consumes
// @aao/contracts and @aao/workflow-dsl as canonical sources of truth; never
// parses workflow source, never redefines Run/Node kinds or statuses, and
// performs no model/tool/agent/approval execution, persistence, or resume.

export type {
  NodeExecutor,
  NodeExecutionContext,
  NodeExecutionResult,
  NodeRegistry,
  RuntimeOptions,
  ExecuteWorkflowRequest,
  NodeExecutionRecord,
  RuntimeExecutionState,
  RuntimeFailureCode,
  RuntimeFailure,
  WorkflowExecutionResult,
} from "./types.js";

export { createNodeRegistry } from "./registry.js";
export { createRuntimeV1Registry, finalOutputExecutor } from "./default-registry.js";
export { applyStatePatch, cloneRunState, captureStateSnapshot } from "./state.js";
export { runPreflight } from "./preflight.js";
export { validateRuntimeInput } from "./runtime-input-validation.js";
export { validateNodeExecutionResult } from "./node-result-validation.js";
export { isJsonSafe } from "./json-safety.js";
export { executeWorkflow } from "./engine.js";

export type { RuntimeClock } from "./clock.js";
export { createSystemClock } from "./clock.js";

export { isLegalRunTransition, transitionRunRecord, createRunRecord, setCurrentNodeId, IllegalRunTransitionError } from "./run-lifecycle.js";

export type { NodeStatusMap } from "./node-lifecycle.js";
export { isLegalNodeTransition, transitionNodeStatus, initializeNodeStatuses, IllegalNodeTransitionError } from "./node-lifecycle.js";

export { RuntimeExecutionSnapshotSchema, type RuntimeExecutionSnapshot, captureExecutionSnapshot, validateSnapshotAgainstPlan } from "./execution-snapshot.js";
