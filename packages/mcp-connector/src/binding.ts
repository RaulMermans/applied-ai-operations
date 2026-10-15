import { RetrySafetySchema, ToolSpecSchema, type RetrySafety, type ToolSpec } from "@aao/contracts";
import { compileToolSchema, type RegisteredTool, type ToolHandlerContext } from "@aao/tool-runtime";
import { cloneJson, isWireJson } from "./json.js";
import { resolveSessionBinding } from "./session.js";
import { McpConnectorError, type McpSession } from "./types.js";

/**
 * Host-owned policy and explicit remote selection. Discovery supplies none
 * of the spec and none of the safety metadata.
 *
 * `retrySafety` is trusted host configuration (ADR-025), and the only way an
 * MCP Tool can become Runtime-retryable. It defaults to `"unsafe"`. `"safe"`
 * is accepted only when every permission class is `read_only` (the Tool
 * Runtime's own rule), and only when the host knows the remote operation is
 * repeat-safe. It is never inferred from the Tool's name, description,
 * annotations, or any server-advertised hint. Crash-recovery safety stays
 * the Tool Runtime's canonical derivation from the same trusted fields. The
 * connector does not forward `toolExecutionId` to the server, so it cannot
 * honor `idempotency: "execution_id"`, and that assertion is refused.
 */
export interface McpToolBinding {
  session: McpSession;
  remoteToolName: string;
  spec: ToolSpec;
  retrySafety?: RetrySafety;
}

export async function createMcpToolBinding(binding: McpToolBinding): Promise<RegisteredTool> {
  const parsed = isWireJson(binding.spec) ? ToolSpecSchema.safeParse(binding.spec) : undefined;
  if (parsed === undefined || !parsed.success || parsed.data.inputSchema.type !== "object") throw new McpConnectorError("MCP_INVALID_BINDING");
  if ("idempotency" in binding) throw new McpConnectorError("MCP_INVALID_BINDING");
  const retrySafety = binding.retrySafety === undefined ? undefined : RetrySafetySchema.safeParse(binding.retrySafety);
  if (retrySafety !== undefined && !retrySafety.success) throw new McpConnectorError("MCP_INVALID_BINDING");
  if (retrySafety?.data === "safe" && !parsed.data.permissionClasses.every((permissionClass) => permissionClass === "read_only")) throw new McpConnectorError("MCP_INVALID_BINDING");
  const spec = cloneJson(parsed.data);
  if (!compileToolSchema(spec.inputSchema).ok || !compileToolSchema(spec.outputSchema).ok) throw new McpConnectorError("MCP_INVALID_BINDING");
  const internal = resolveSessionBinding(binding.session);
  const remoteToolName = binding.remoteToolName;
  const tools = await binding.session.listTools();
  if (!tools.some((tool) => tool.name === remoteToolName)) throw new McpConnectorError("MCP_TOOL_NOT_AVAILABLE");
  return {
    spec,
    handler: Object.freeze({ execute: (context: ToolHandlerContext) => internal.invoke(remoteToolName, context.input) }),
    ...(retrySafety?.success ? { retrySafety: retrySafety.data } : {}),
  };
}
