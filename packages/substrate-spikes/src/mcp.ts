// KEEP_AS_HISTORICAL_EVIDENCE — Sprint 0A in-memory research only.
// Its toy permission check is not AAO authorization. Production MCP lives
// exclusively in @aao/mcp-connector and inherits executeTool (ADR-015).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export class McpAuthorizationError extends Error {}
export type McpPermission = { tool: string; allowed: boolean };

export async function createLocalMcpLab() {
  let invocations = 0;
  const server = new McpServer({ name: "aao-local-test-server", version: "0.0.0" });
  server.registerTool(
    "crm.read_account",
    {
      description: "Read one test account; it has no side effects.",
      inputSchema: { accountId: z.string().min(1) },
    },
    async ({ accountId }) => {
      invocations += 1;
      const result = { id: accountId, name: "Local Test Account" };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    },
  );
  const client = new Client({ name: "aao-local-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    invocations: () => invocations,
    close: async () => {
      await Promise.all([client.close(), server.close()]);
    },
  };
}

/** Policy check intentionally runs before client.callTool, keeping MCP a connector only. */
export async function invokeAuthorizedRead(
  client: Client,
  permission: McpPermission,
  args: unknown,
) {
  if (permission.tool !== "crm.read_account" || !permission.allowed) {
    throw new McpAuthorizationError("AAO policy denied MCP invocation");
  }
  const validated = z.object({ accountId: z.string().min(1) }).safeParse(args);
  if (!validated.success) throw new McpAuthorizationError("AAO rejected invalid MCP arguments");
  return client.callTool({ name: permission.tool, arguments: validated.data });
}
