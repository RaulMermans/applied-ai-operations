// @aao/model-runtime — AAO's provider-neutral model execution layer (Sprint 6;
// see docs/architecture/model-runtime.md and ADR-011). Owns ModelRequest /
// ModelResult / ModelFailure semantics, an explicit Model Registry and Model
// Policy Registry, deterministic capability routing, the ModelAdapter
// contract, and the `model` NodeExecutor bridge into @aao/runtime.
//
// The Vercel AI SDK adapter is deliberately NOT exported from here: import
// it from "@aao/model-runtime/vercel-ai", so this entry point never loads `ai`.
// No agents, tools, retries, fallback, memory, or prompt templating.

export {
  MODEL_CAPABILITIES,
  ModelCapabilityIdSchema,
  ModelMessageSchema,
  ModelOutputSpecSchema,
  MAX_OUTPUT_TOKENS_CEILING,
  ModelRequestSchema,
  ModelFinishReasonSchema,
  ModelUsageSchema,
  ModelResultSchema,
  MODEL_FAILURE_CODES,
  ModelFailureCodeSchema,
  ModelFailureSchema,
} from "./types.js";
export type {
  ModelCapabilityId,
  ModelMessage,
  ModelOutputSpec,
  ModelOutputKind,
  ModelRequest,
  ModelFinishReason,
  ModelUsage,
  ModelResult,
  ModelFailureCode,
  ModelFailure,
  ModelExecutionResult,
  ModelAdapter,
  ModelAdapterRequest,
  ModelAdapterResult,
  ModelAdapterFailureReason,
} from "./types.js";

export { validateModelRequest } from "./request.js";
export { createModelRegistry, type ModelBinding, type ModelRegistry } from "./registry.js";
export { createModelPolicyRegistry, hasUnsupportedConstraints, type ModelPolicyRegistry } from "./policy-registry.js";
export { deriveRequiredCapabilities, selectModelBinding } from "./router.js";
export { executeModelRequest, type ExecuteModelRequestParams } from "./executor.js";
export { createModelNodeExecutor, ModelNodeConfigSchema, ModelNodeExecutionError, type ModelNodeConfig, type ModelNodeExecutorDependencies } from "./model-node.js";
