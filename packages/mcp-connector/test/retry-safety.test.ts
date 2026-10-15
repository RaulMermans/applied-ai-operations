import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolSpec } from "@aao/contracts";
import { createToolNodeExecutor, createToolRegistry, executeTool } from "@aao/tool-runtime";
import { MCP_CONNECTOR_ADAPTER_MANIFEST, createMcpSession, createMcpToolBinding, type McpSession } from "../src/index.js";
import { AUTH, REQUEST, SPEC } from "./fixtures.js";

/**
 * ADR-025: MCP retry safety is trusted host configuration only. It defaults
 * to unsafe, is never read from server metadata, and maps into the Tool
 * Runtime's canonical `retrySafety`. Crash-recovery safety stays the Tool
 * Runtime's own derivation, kept distinct from retry safety.
 */
const SERVER = fileURLToPath(new URL("../conformance/server.mjs", import.meta.url));
const sessions: McpSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

async function connected(outcomes: string[], hostile = true): Promise<McpSession> {
  const session = createMcpSession({ command: process.execPath, args: [SERVER, JSON.stringify({ outcomes, hostile })] });
  sessions.push(session);
  await session.connect();
  return session;
}
const writeDraft: ToolSpec = { ...SPEC, permissionClasses: ["write_draft"] };
const recoverySafety = (tool: Parameters<ReturnType<typeof createToolRegistry>["register"]>[0]) => {
  const tools = createToolRegistry();
  tools.register(tool);
  const node = createToolNodeExecutor({ tools, resolveAuthorizationContext: () => undefined });
  return node.recoverySafety!({ node: { id: "read", kind: "tool", config: { toolRef: { id: tool.spec.id, version: tool.spec.version }, inputStateKey: "in", resultStateKey: "out" } } });
};

describe("MCP connector adapter manifest", () => {
  it("is a tool_provider claiming only what the connector implements", () => {
    expect(MCP_CONNECTOR_ADAPTER_MANIFEST).toMatchObject({ id: "aao.mcp-connector", version: "1.0.0", kind: "tool_provider", adapterContractVersion: 1 });
    expect(MCP_CONNECTOR_ADAPTER_MANIFEST.capabilities).toEqual([
      { capability: "tool.discovery", support: "supported" },
      { capability: "tool.execution", support: "supported" },
      { capability: "tool.retryable_failure", support: "supported" },
    ]);
    expect(JSON.stringify(MCP_CONNECTOR_ADAPTER_MANIFEST)).not.toMatch(/workflow_runtime|agent_runtime|governance|approval_provider|authorization_provider|durability_provider|permission/);
  });
});

describe("host-owned MCP retry safety", () => {
  it("defaults to unsafe: no declaration means the binding carries none, and server hints are never read", async () => {
    const session = await connected(["success"]);
    const discovered = await session.listTools();
    // Discovery evidence keeps no annotations, _meta, or non-standard safety fields.
    expect(Object.keys(discovered[0]!).sort()).toEqual(["description", "inputSchema", "name"]);
    const binding = await createMcpToolBinding({ session, remoteToolName: "crm.read_account", spec: SPEC });
    expect(binding.retrySafety).toBeUndefined();
    expect(recoverySafety(binding)).toBe("unsafe");
  }, 30_000);

  it("a host may declare a read_only binding retry-safe, mapped into the canonical retrySafety (and so, canonically, recovery-safe)", async () => {
    const session = await connected(["success"]);
    const binding = await createMcpToolBinding({ session, remoteToolName: "crm.read_account", spec: SPEC, retrySafety: "safe" });
    expect(binding.retrySafety).toBe("safe");
    expect(recoverySafety(binding)).toBe("safe");
  }, 30_000);

  it("refuses retry-safe for a mutation-like class, an invalid value, and any idempotency assertion (execution_id is not forwarded)", async () => {
    const session = await connected(["success"]);
    await expect(createMcpToolBinding({ session, remoteToolName: "crm.read_account", spec: writeDraft, retrySafety: "safe" })).rejects.toMatchObject({ code: "MCP_INVALID_BINDING" });
    await expect(createMcpToolBinding({ session, remoteToolName: "crm.read_account", spec: SPEC, retrySafety: "always" as never })).rejects.toMatchObject({ code: "MCP_INVALID_BINDING" });
    for (const idempotency of ["execution_id", "none"]) {
      await expect(createMcpToolBinding({ session, remoteToolName: "crm.read_account", spec: writeDraft, idempotency } as never)).rejects.toMatchObject({ code: "MCP_INVALID_BINDING" });
    }
  }, 30_000);

  it("retry safety ≠ recovery safety: a write_draft MCP Tool is never recovery-safe, whatever the server claims", async () => {
    const session = await connected(["success"]);
    const binding = await createMcpToolBinding({ session, remoteToolName: "crm.read_account", spec: writeDraft });
    expect(binding.retrySafety).toBeUndefined();
    expect(recoverySafety(binding)).toBe("unsafe");
  }, 30_000);
});

describe("transient remote failure classification", () => {
  it("a server-side internal error is reported retryable, bounded to its code; the Tool Runtime keeps it as handler evidence only", async () => {
    const session = await connected(["transient_failure"]);
    const tools = createToolRegistry();
    tools.register(await createMcpToolBinding({ session, remoteToolName: "crm.read_account", spec: SPEC }));
    const result = await executeTool({ tools, request: REQUEST, authorizationContext: AUTH });
    expect(result).toMatchObject({ ok: false, failure: { code: "TOOL_EXECUTION_FAILED", handlerFailureCode: "MCP_CALL_FAILED", handlerFailureRetryable: true } });
    expect(JSON.stringify(result)).not.toMatch(/secret-token|private\.invalid|server-stack/);
  }, 30_000);

  it("a tool-reported error (isError) is not transient", async () => {
    const session = await connected(["failure"]);
    const tools = createToolRegistry();
    tools.register(await createMcpToolBinding({ session, remoteToolName: "crm.read_account", spec: SPEC }));
    const result = await executeTool({ tools, request: REQUEST, authorizationContext: AUTH });
    expect(result).toMatchObject({ ok: false, failure: { handlerFailureCode: "MCP_TOOL_REPORTED_ERROR" } });
    expect(!result.ok && result.failure.handlerFailureRetryable).toBeUndefined();
  }, 30_000);
});
