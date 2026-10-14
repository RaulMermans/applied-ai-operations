// @aao/framework — the recommended developer entry point to Applied AI
// Operations (Sprint 19, ADR-024, docs/architecture/framework-surface.md).
//
// A façade over AAO Core, never a second implementation: definitions are
// validated by the canonical contracts, Workflows compile through the
// Workflow DSL compiler, and execution runs through the existing Runtime,
// Tool Runtime, Governance, Authorization, and Approval Engine. Identity
// comes only from the trusted host (`principalForRun`).
//
// Everything exported here is intentional consumer API. The list is
// explicit — never `export *` — and pinned by the public API snapshot test;
// adding or removing a symbol is a deliberate change, and a breaking change
// needs an ADR or migration note. Adapter contracts (model, MCP, LangGraph,
// manifests, conformance vocabulary) are deliberately absent: Sprint 20.

export { AAO_FRAMEWORK_API_VERSION } from "./version.js";
export { AAOFrameworkError, type AAOFrameworkDiagnostic, type AAOFrameworkErrorCode } from "./errors.js";
export { defineAgent, defineEval, defineGovernance, defineModelPolicy, defineTool, defineWorkflow, type ToolDefinition, type ToolDefinitionInput } from "./definitions.js";
export { createAAO, type AAOApp, type AAOApprovals, type AAOClock, type AAOOptions, type ExecuteWorkflowInput, type PreparedWorkflow, type PrincipalForRun } from "./app.js";

// Canonical AAO contract types, re-exported by name (type-only) so a
// consumer never needs a lower-level package import. They are the Core
// types themselves, not Framework copies.
export type {
  AgentSpec,
  ApprovalRecord,
  EvalDefinition,
  GovernanceConfiguration,
  JsonObject,
  JsonValue,
  ModelPolicySpec,
  PermissionClass,
  Principal,
  RetrySafety,
  RunState,
  ToolIdempotency,
  ToolSpec,
  Workflow,
} from "@aao/contracts";
export type { RuntimeExecutionState, RuntimeFailure, WorkflowExecutionResult } from "@aao/runtime";
export type { ToolHandler, ToolHandlerContext, ToolHandlerResult } from "@aao/tool-runtime";
export type { WorkflowDiagnostic } from "@aao/workflow-dsl";
