// @aao/model-runtime — AAO's provider-neutral model execution layer (Sprint 6;
// see docs/architecture/model-runtime.md and ADR-011). Owns ModelRequest /
// ModelResult / ModelFailure semantics, an explicit Model Registry and Model
// Policy Registry, deterministic capability routing, the ModelAdapter
// contract, and the `model` NodeExecutor bridge into @aao/runtime.
//
// The Vercel AI SDK adapter is deliberately NOT exported from here: import
// it from "@aao/model-runtime/vercel-ai", so this entry point never loads `ai`.
// Its conformance subject is the explicit "@aao/model-runtime/vercel-ai/conformance"
// subpath. No agents, tools, retries, fallback, memory, or prompt templating.
//
// Since Sprint 20 (ADR-025) `ModelAdapter` is the public `model` adapter
// port: this package is its single owner, and `defineModelAdapter` pairs it
// with an @aao/adapters `AdapterManifest`.

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
  ModelAdapterContext,
  ModelAdapterRequest,
  ModelAdapterResult,
  ModelAdapterFailureReason,
} from "./types.js";

export { validateModelRequest } from "./request.js";
export { defineModelAdapter, type ModelAdapterDefinition, type ModelAdapterDefinitionInput } from "./adapter-definition.js";
export { createModelRegistry, ModelBindingIdentitySchema, type ModelBinding, type ModelBindingIdentity, type ModelRegistry } from "./registry.js";
export { createModelPolicyRegistry, hasUnsupportedConstraints, type ModelPolicyRegistry } from "./policy-registry.js";
export { deriveRequiredCapabilities, selectModelBinding } from "./router.js";
export { executeModelRequest, type ExecuteModelRequestParams, type ModelInvocationObserver } from "./executor.js";
export { createModelNodeExecutor, modelTraceObserver, ModelNodeConfigSchema, MODEL_NODE_FAILURE_NAMESPACE, type ModelNodeConfig, type ModelNodeExecutorDependencies } from "./model-node.js";
