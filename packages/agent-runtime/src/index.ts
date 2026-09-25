// @aao/agent-runtime — AAO's bounded Agent Runtime (Sprint 7; see
// docs/architecture/agent-runtime.md and ADR-012). A deterministic controller
// runs one registered Agent for at most `maxIterations` iterations; each
// iteration is exactly one AAO Model Runtime invocation returning a structured
// AgentDecision (CONTINUE | COMPLETE). The model proposes; the controller
// decides. Uses @aao/model-runtime only — never the AI SDK or a provider SDK.
// No tools, skills, delegation, memory, persistence, retries, fallback, or
// Reflexion. The `agent` NodeExecutor bridges it into @aao/runtime.

export {
  AgentRefSchema,
  MAX_AGENT_ITERATIONS_CEILING,
  MAX_OUTPUT_TOKENS_PER_ITERATION_CEILING,
  AgentLimitsSchema,
  MAX_AGENT_INSTRUCTIONS_LENGTH,
  RegisteredAgentSchema,
  MAX_AGENT_EXECUTION_ID_LENGTH,
  MAX_AGENT_TASK_LENGTH,
  AgentExecutionRequestSchema,
  AGENT_ACTIONS,
  AgentActionSchema,
  AgentDecisionSchema,
  AgentIterationRecordSchema,
  AgentResultSchema,
  AGENT_FAILURE_CODES,
  AgentFailureCodeSchema,
  AgentFailureSchema,
} from "./types.js";
export type {
  AgentRef,
  AgentLimits,
  RegisteredAgent,
  AgentExecutionRequest,
  AgentAction,
  AgentDecision,
  AgentIterationRecord,
  AgentResult,
  AgentFailureCode,
  AgentFailure,
  AgentExecutionResult,
  AgentExecutionState,
} from "./types.js";

export { createAgentRegistry, type AgentRegistry } from "./registry.js";
export { resolveExecutableAgent, type AgentResolution, type AgentResolutionDependencies } from "./resolution.js";
export { AGENT_DECISION_JSON_SCHEMA, buildIterationModelRequest } from "./decision.js";
export { executeAgent, type AgentRuntimeDependencies, type ExecuteAgentParams } from "./controller.js";
export { createAgentNodeExecutor, AgentNodeConfigSchema, AGENT_NODE_FAILURE_NAMESPACE, type AgentNodeConfig } from "./agent-node.js";
