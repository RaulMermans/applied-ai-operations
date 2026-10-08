// @aao/tool-runtime — AAO's Tool Runtime (Sprints 8–9; see
// docs/architecture/tool-runtime.md, ADR-013, and ADR-014). Executes
// explicitly registered, schema-validated, locally trusted Tools through one
// deterministic boundary: request → registry → permission support gate →
// authorization (@aao/authorization, host-attested context required) →
// inputSchema → handler (at most once) → JSON safety → outputSchema →
// ToolResult. Only `read_only` / `write_draft` Tools execute; everything else
// fails closed whatever the grants. `executeTool` is the only exported path
// that invokes a registered handler: registry lookups expose specs only. No
// MCP, connectors, credentials, side effects, retries, persistence, or Agent
// Tool use. The `tool` NodeExecutor bridges it into @aao/runtime.

export {
  ToolRefSchema,
  HANDLER_FAILURE_CODE_PATTERN,
  HandlerFailureCodeSchema,
  ToolExecutionRequestSchema,
  ToolResultSchema,
  TOOL_FAILURE_CODES,
  ToolFailureCodeSchema,
  ToolFailureSchema,
} from "./types.js";
export type {
  ToolRef,
  ToolHandlerContext,
  ToolHandlerResult,
  ToolHandler,
  RegisteredTool,
  ToolExecutionRequest,
  ToolResult,
  ToolFailureCode,
  ToolFailure,
  ToolExecutionResult,
} from "./types.js";

export { compileToolSchema, type CompiledToolSchema } from "./schema-validator.js";
export { SUPPORTED_TOOL_PERMISSION_CLASSES, checkToolPermissionSupport } from "./permissions.js";
export { createToolRegistry, type ToolRegistry } from "./registry.js";
export { executeTool, type ToolRuntimeDependencies, type ExecuteToolParams, type ToolExecutionObserver } from "./executor.js";
export type { ToolAccessAuditBinding } from "./tool-audit.js";
export { deriveToolExecutionId } from "./execution-id.js";
export {
  createToolNodeExecutor,
  ToolNodeConfigSchema,
  TOOL_NODE_FAILURE_NAMESPACE,
  classifyToolFailure,
  type ToolNodeConfig,
  type ToolNodeDependencies,
  type ToolAuthorizationTarget,
  type ResolveToolAuthorizationContext,
} from "./tool-node.js";
