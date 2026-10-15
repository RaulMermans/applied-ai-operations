import { defineAdapterManifest, type AdapterManifest } from "@aao/adapters";

/**
 * The MCP connector's adapter manifest (adapter contract v1, ADR-025).
 * MCP is a `tool_provider`, permanently. It is not an agent runtime, a
 * workflow runtime, or a governance, authorization, approval, or
 * durability provider. It claims only what the connector implements and the
 * canonical conformance suite verifies. Remote server metadata can describe
 * a Tool, but never determines a permission class, retry or recovery
 * safety, idempotency, identity, or Approval. The host decides all of those.
 */
export const MCP_CONNECTOR_ADAPTER_MANIFEST: AdapterManifest = defineAdapterManifest({
  id: "aao.mcp-connector",
  version: "1.0.0",
  kind: "tool_provider",
  displayName: "MCP connector (official SDK, stdio)",
  capabilities: [
    { capability: "tool.discovery", support: "supported" },
    { capability: "tool.execution", support: "supported" },
    { capability: "tool.retryable_failure", support: "supported" },
  ],
  limitations: [
    { code: "transport.stdio_only", description: "One explicit stdio session per server. No HTTP transport, remote authentication flows, resources, prompts, or sampling." },
    { code: "tool.structured_output_required", description: "A remote result without structured content fails closed." },
    { code: "tool.execution_id_not_forwarded", description: "The toolExecutionId is not sent to the server, so execution_id idempotency cannot be asserted. A write_draft MCP Tool is never recovery-safe." },
  ],
});
