import type { JsonObject } from "@aao/contracts";

/** Trusted host infrastructure configuration; never workflow data. */
export interface McpStdioConfig {
  command: string;
  args?: string[];
}

export type McpSessionState = "CREATED" | "CONNECTING" | "READY" | "FAILED" | "CLOSED";

/** External discovery evidence only: no annotations, instructions, or authority. */
export interface McpDiscoveredTool {
  name: string;
  description?: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
}

/** Infrastructure object. Never serialize this into AAO state or contracts. */
export interface McpSession {
  readonly state: McpSessionState;
  readonly connect: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly listTools: () => Promise<McpDiscoveredTool[]>;
}

export const MCP_FAILURE_CODES = [
  "MCP_SESSION_NOT_READY",
  "MCP_CONNECTION_FAILED",
  "MCP_TOOLS_UNSUPPORTED",
  "MCP_DISCOVERY_FAILED",
  "MCP_INVALID_DISCOVERY",
  "MCP_DISCOVERY_LIMIT_EXCEEDED",
  "MCP_TOOL_NOT_AVAILABLE",
  "MCP_INVALID_BINDING",
  "MCP_CALL_FAILED",
  "MCP_TOOL_REPORTED_ERROR",
  "MCP_INVALID_RESULT",
  "MCP_STRUCTURED_OUTPUT_REQUIRED",
] as const;
export type McpFailureCode = (typeof MCP_FAILURE_CODES)[number];

/** Safe host setup failure; contains only a bounded code, never an SDK cause. */
export class McpConnectorError extends Error {
  constructor(readonly code: McpFailureCode) {
    super(code);
    this.name = "McpConnectorError";
  }
}
