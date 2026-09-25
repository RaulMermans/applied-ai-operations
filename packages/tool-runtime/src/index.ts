// @aao/tool-runtime — AAO's Tool Runtime (Sprint 8; see
// docs/architecture/tool-runtime.md and ADR-013). Executes explicitly
// registered, schema-validated, locally trusted Tools through one
// deterministic boundary: request → registry → permission support gate →
// inputSchema → handler (at most once) → JSON safety → outputSchema →
// ToolResult. Only `read_only` / `write_draft` Tools execute; everything else
// fails closed. This gate is not authorization. No MCP, connectors,
// credentials, side effects, retries, persistence, or Agent Tool use. The
// `tool` NodeExecutor bridges it into @aao/runtime.

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
export { createToolRegistry, type ToolRegistry, type ResolvedTool } from "./registry.js";
export { executeTool, type ToolRuntimeDependencies, type ExecuteToolParams } from "./executor.js";
export { deriveToolExecutionId } from "./execution-id.js";
export { createToolNodeExecutor, ToolNodeConfigSchema, TOOL_NODE_FAILURE_NAMESPACE, type ToolNodeConfig } from "./tool-node.js";
