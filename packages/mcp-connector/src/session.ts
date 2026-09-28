import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { JsonObjectSchema, type JsonValue } from "@aao/contracts";
import type { ToolHandlerResult } from "@aao/tool-runtime";
import { z } from "zod";
import { cloneJson, isWireJson } from "./json.js";
import { McpConnectorError, type McpDiscoveredTool, type McpSession, type McpSessionState, type McpStdioConfig } from "./types.js";

const ConfigSchema = z.object({ command: z.string().min(1), args: z.array(z.string()).optional() }).strict();
// Match the installed SDK's bounded schema envelope; do not translate dialects.
const RemoteSchemaShape = z.object({
  type: z.literal("object"),
  properties: z.record(JsonObjectSchema).optional(),
  required: z.array(z.string()).optional(),
});
const RemoteSchema = JsonObjectSchema.refine((schema) => RemoteSchemaShape.safeParse(schema).success);
const DiscoveryToolSchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(4096).optional(),
  inputSchema: RemoteSchema,
  outputSchema: RemoteSchema.optional(),
});
const PageSchema = z.object({ tools: z.array(DiscoveryToolSchema).max(1000), nextCursor: z.string().min(1).max(4096).optional() });
const MAX_DISCOVERY_PAGES = 32;
const MAX_DISCOVERED_TOOLS = 1000;

interface SessionBinding {
  invoke: (remoteToolName: string, input: JsonValue) => Promise<ToolHandlerResult>;
}
// Private execution access, keyed by isolated host-created infrastructure objects.
const sessionBindings = new WeakMap<McpSession, SessionBinding>();

/** Internal only; the package exports no direct MCP invocation API. */
export function resolveSessionBinding(session: McpSession): SessionBinding {
  const binding = sessionBindings.get(session);
  if (binding === undefined) throw new McpConnectorError("MCP_INVALID_BINDING");
  return binding;
}

export function createMcpSession(config: McpStdioConfig): McpSession {
  const parsed = ConfigSchema.safeParse(config);
  if (!parsed.success) throw new McpConnectorError("MCP_CONNECTION_FAILED");
  // Copies host config now. Tool input can never select or mutate this process.
  const transport = new StdioClientTransport({ ...cloneJson(parsed.data), stderr: "ignore" });
  const client = new Client({ name: "aao-mcp-connector", version: "0.0.0" }, { capabilities: {} });
  let state: McpSessionState = "CREATED";
  let discoveredNames = new Set<string>();
  let closePromise: Promise<void> | undefined;
  client.onclose = () => { if (state === "READY") state = "CLOSED"; };
  client.onerror = () => { /* SDK errors never become AAO data or console output. */ };

  async function shutdown(): Promise<void> {
    // Also close transport explicitly: initialization failure may detach it from Client.
    await Promise.allSettled([client.close(), transport.close()]);
  }

  const session: McpSession = Object.freeze({
    get state() { return state; },
    async connect() {
      if (state !== "CREATED") throw new McpConnectorError("MCP_SESSION_NOT_READY");
      state = "CONNECTING";
      try {
        await client.connect(transport);
        if (session.state !== "CONNECTING") throw new McpConnectorError("MCP_SESSION_NOT_READY");
        if (client.getServerCapabilities()?.tools === undefined) throw new McpConnectorError("MCP_TOOLS_UNSUPPORTED");
        state = "READY";
      } catch (error) {
        if (session.state !== "CLOSED") state = "FAILED";
        await shutdown();
        throw error instanceof McpConnectorError ? error : new McpConnectorError("MCP_CONNECTION_FAILED");
      }
    },
    close() {
      state = "CLOSED";
      discoveredNames.clear();
      closePromise ??= shutdown();
      return closePromise;
    },
    async listTools() {
      if (state !== "READY") throw new McpConnectorError("MCP_SESSION_NOT_READY");
      discoveredNames.clear();
      const tools: McpDiscoveredTool[] = [];
      const names = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      try {
        for (let pageIndex = 0; pageIndex < MAX_DISCOVERY_PAGES; pageIndex++) {
          const raw = await client.listTools(cursor === undefined ? undefined : { cursor });
          if (!isWireJson(raw)) throw new McpConnectorError("MCP_INVALID_DISCOVERY");
          const page = PageSchema.safeParse(raw);
          if (!page.success) throw new McpConnectorError("MCP_INVALID_DISCOVERY");
          for (const tool of page.data.tools) {
            if (names.has(tool.name)) throw new McpConnectorError("MCP_INVALID_DISCOVERY");
            try {
              // Syntax/compilability under the installed SDK, never AAO schema
              // equivalence or authority. Fresh providers isolate remote $ids.
              new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
              if (tool.outputSchema !== undefined) new AjvJsonSchemaValidator().getValidator(tool.outputSchema);
            } catch {
              throw new McpConnectorError("MCP_INVALID_DISCOVERY");
            }
            names.add(tool.name);
            tools.push(cloneJson(tool));
            if (tools.length > MAX_DISCOVERED_TOOLS) throw new McpConnectorError("MCP_DISCOVERY_LIMIT_EXCEEDED");
          }
          cursor = page.data.nextCursor;
          if (cursor === undefined) {
            if (session.state !== "READY") throw new McpConnectorError("MCP_SESSION_NOT_READY");
            discoveredNames = names;
            return tools;
          }
          if (cursors.has(cursor)) throw new McpConnectorError("MCP_DISCOVERY_LIMIT_EXCEEDED");
          cursors.add(cursor);
        }
        throw new McpConnectorError("MCP_DISCOVERY_LIMIT_EXCEEDED");
      } catch (error) {
        throw error instanceof McpConnectorError ? error : new McpConnectorError("MCP_DISCOVERY_FAILED");
      }
    },
  });

  sessionBindings.set(session, {
    async invoke(remoteToolName, input) {
      if (state !== "READY") return { ok: false, code: "MCP_SESSION_NOT_READY" };
      if (!discoveredNames.has(remoteToolName)) return { ok: false, code: "MCP_TOOL_NOT_AVAILABLE" };
      if (!isWireJson(input) || input === null || typeof input !== "object" || Array.isArray(input)) return { ok: false, code: "MCP_INVALID_BINDING" };
      try {
        // Exactly one call. No catch path retries, reconnects, or replays it.
        const raw = await client.callTool({ name: remoteToolName, arguments: cloneJson(input) });
        if (raw.isError === true) return { ok: false, code: "MCP_TOOL_REPORTED_ERROR" };
        if (raw.structuredContent === undefined) return { ok: false, code: "MCP_STRUCTURED_OUTPUT_REQUIRED" };
        if (!isWireJson(raw.structuredContent) || raw.structuredContent === null || Array.isArray(raw.structuredContent) || typeof raw.structuredContent !== "object") return { ok: false, code: "MCP_INVALID_RESULT" };
        return { ok: true, output: cloneJson(raw.structuredContent) };
      } catch {
        return { ok: false, code: "MCP_CALL_FAILED" };
      }
    },
  });
  return session;
}
