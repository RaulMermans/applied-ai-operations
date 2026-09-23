// @aao/contracts — the canonical, framework-neutral, vendor-neutral domain
// contract package for Applied AI Operations. See ADR-007 and
// docs/architecture/domain-contracts.md for the architecture this package
// implements. Every export here must remain JSON-safe, runtime-validatable
// via Zod, and free of framework/vendor/provider types.

export {
  schemaVersionSchema,
  identifierSchema,
  entityVersionSchema,
  isoTimestampSchema,
  WorkflowIdSchema,
  NodeIdSchema,
  RunIdSchema,
  CheckpointIdSchema,
  AgentIdSchema,
  SkillIdSchema,
  ToolIdSchema,
  CapabilityIdSchema,
  PolicyIdSchema,
  ApprovalIdSchema,
  EvalIdSchema,
  TraceEventIdSchema,
  ArtifactIdSchema,
  CompanyIdSchema,
  CapabilityPackIdSchema,
  ModelPolicyIdSchema,
  JsonPrimitiveSchema,
  JsonValueSchema,
  JsonArraySchema,
  JsonObjectSchema,
  type EntityVersion,
  type WorkflowId,
  type NodeId,
  type RunId,
  type CheckpointId,
  type AgentId,
  type SkillId,
  type ToolId,
  type CapabilityId,
  type PolicyId,
  type ApprovalId,
  type EvalId,
  type TraceEventId,
  type ArtifactId,
  type CompanyId,
  type CapabilityPackId,
  type ModelPolicyId,
  type JsonPrimitive,
  type JsonValue,
  type JsonArray,
  type JsonObject,
} from "./common.js";

export {
  PermissionClassSchema,
  PermissionClassesSchema,
  PolicyDecisionValueSchema,
  PolicyDecisionSchema,
  type PermissionClass,
  type PermissionClasses,
  type PolicyDecisionValue,
  type PolicyDecision,
} from "./governance.js";

export { RunStatusSchema, NodeStatusSchema, RunRecordSchema, type RunStatus, type NodeStatus, type RunRecord } from "./run.js";

export {
  NodeKindSchema,
  NodeDefinitionSchema,
  EdgeDefinitionSchema,
  WorkflowSchema,
  type NodeKind,
  type NodeDefinition,
  type EdgeDefinition,
  type Workflow,
} from "./workflow.js";

export {
  RunStateSchema,
  StateSnapshotSchema,
  CheckpointRecordSchema,
  type RunState,
  type StateSnapshot,
  type CheckpointRecord,
} from "./state.js";

export { AgentSpecSchema, type AgentSpec } from "./agent.js";
export { SkillSpecSchema, type SkillSpec } from "./skill.js";
export { ModelPolicySpecSchema, type ModelPolicySpec } from "./model.js";
export { ToolSpecSchema, type ToolSpec } from "./tool.js";
export { CapabilitySpecSchema, type CapabilitySpec } from "./capability.js";

export {
  ApprovalStatusSchema,
  ApprovalRecordSchema,
  type ApprovalStatus,
  type ApprovalRecord,
} from "./approval.js";

export {
  EvalModeSchema,
  EvalTargetTypeSchema,
  EvalDefinitionSchema,
  EvalResultStatusSchema,
  EvalResultSchema,
  type EvalMode,
  type EvalTargetType,
  type EvalDefinition,
  type EvalResultStatus,
  type EvalResult,
} from "./evaluation.js";

export { TraceEventSchema, type TraceEvent } from "./trace.js";
export { ArtifactRefSchema, type ArtifactRef } from "./artifact.js";
export { CapabilityPackRefSchema, type CapabilityPackRef } from "./capability-pack.js";
export { CompanyConfigSchema, type CompanyConfig } from "./deployment.js";
