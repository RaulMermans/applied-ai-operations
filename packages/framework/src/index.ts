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
// needs an ADR or migration note.
//
// Sprint 20 (ADR-025) adds the stable adapter-contract concepts only: the
// contract version, manifest definition, compatibility check, the canonical
// ModelAdapter port and `defineModelAdapter`, and the deterministic executor
// shape. Concrete adapters (Vercel AI SDK, MCP) are never exported here.
// Hosts import them from their own packages. Conformance verification is
// the explicit "@aao/framework/conformance" subpath.

export { AAO_FRAMEWORK_API_VERSION } from "./version.js";
export { AAOFrameworkError, type AAOFrameworkDiagnostic, type AAOFrameworkErrorCode } from "./errors.js";
export { defineAgent, defineEval, defineGovernance, defineModelPolicy, defineTool, defineWorkflow, type ToolDefinition, type ToolDefinitionInput } from "./definitions.js";
export { createAAO, type AAOApp, type AAOApprovals, type AAOClock, type AAOOptions, type ExecuteWorkflowInput, type PreparedWorkflow, type PrepareWorkflowOptions, type PrincipalForRun } from "./app.js";
export type { AgentDefinition, ModelBindingDefinition } from "./models.js";

// The adapter and portability contract (ADR-025), re-exported by name from
// its single owners: @aao/adapters (envelope) and @aao/model-runtime (the
// ModelAdapter port).
export { AAO_ADAPTER_CONTRACT_VERSION, AdapterContractError, checkAdapterCompatibility, defineAdapterManifest } from "@aao/adapters";
export type { AdapterCapability, AdapterCompatibilityResult, AdapterConformanceReport, AdapterKind, AdapterManifest, AdapterManifestInput, AdapterRef } from "@aao/adapters";
export { defineModelAdapter } from "@aao/model-runtime";
export type { ModelAdapter, ModelAdapterContext, ModelAdapterDefinition, ModelAdapterRequest, ModelAdapterResult, ModelRequest, ModelResult } from "@aao/model-runtime";

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
  ReliabilityPolicy,
  RetrySafety,
  RunState,
  ToolIdempotency,
  ToolSpec,
  Workflow,
} from "@aao/contracts";
export type { DeterministicExecutor, DeterministicExecutorContext, DeterministicExecutorResult, RuntimeExecutionState, RuntimeFailure, RuntimeTracePort, WorkflowExecutionResult } from "@aao/runtime";
export type { ToolHandler, ToolHandlerContext, ToolHandlerResult } from "@aao/tool-runtime";
export type { WorkflowDiagnostic } from "@aao/workflow-dsl";
