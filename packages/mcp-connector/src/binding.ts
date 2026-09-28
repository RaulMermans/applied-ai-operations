import { ToolSpecSchema, type ToolSpec } from "@aao/contracts";
import { compileToolSchema, type RegisteredTool, type ToolHandlerContext } from "@aao/tool-runtime";
import { cloneJson, isWireJson } from "./json.js";
import { resolveSessionBinding } from "./session.js";
import { McpConnectorError, type McpSession } from "./types.js";

/** Host-owned policy and explicit remote selection. Discovery supplies none of the spec. */
export interface McpToolBinding {
  session: McpSession;
  remoteToolName: string;
  spec: ToolSpec;
}

export async function createMcpToolBinding(binding: McpToolBinding): Promise<RegisteredTool> {
  const parsed = isWireJson(binding.spec) ? ToolSpecSchema.safeParse(binding.spec) : undefined;
  if (parsed === undefined || !parsed.success || parsed.data.inputSchema.type !== "object") throw new McpConnectorError("MCP_INVALID_BINDING");
  const spec = cloneJson(parsed.data);
  if (!compileToolSchema(spec.inputSchema).ok || !compileToolSchema(spec.outputSchema).ok) throw new McpConnectorError("MCP_INVALID_BINDING");
  const internal = resolveSessionBinding(binding.session);
  const remoteToolName = binding.remoteToolName;
  const tools = await binding.session.listTools();
  if (!tools.some((tool) => tool.name === remoteToolName)) throw new McpConnectorError("MCP_TOOL_NOT_AVAILABLE");
  return { spec, handler: Object.freeze({ execute: (context: ToolHandlerContext) => internal.invoke(remoteToolName, context.input) }) };
}
