import { afterEach, describe, expect, it } from "vitest";
import { createToolRegistry, executeTool, ToolResultSchema } from "@aao/tool-runtime";
import { compileWorkflowSource } from "@aao/workflow-dsl";
import { createNodeRegistry } from "@aao/runtime";
import { executeWorkflow, finalOutputExecutor } from "@aao/runtime";
import { createToolNodeExecutor } from "@aao/tool-runtime";
import { createMcpToolBinding } from "../src/index.js";
import { AUTH, REF, REQUEST, SPEC, realServer } from "./fixtures.js";

const servers: ReturnType<typeof realServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.cleanup())); });
function fixture(mode = "ok") { const server = realServer(mode); servers.push(server); return server; }
async function governed(mode = "ok", spec = SPEC) {
  const server = fixture(mode);
  await server.session.connect();
  const tools = createToolRegistry();
  tools.register(await createMcpToolBinding({ session: server.session, remoteToolName: "crm.read_account", spec }));
  return { ...server, tools };
}

describe("official SDK stdio and governed MCP E2E", () => {
  it("initializes, discovers, explicitly binds, authorizes, invokes once, validates and closes", async () => {
    const server = fixture("schema");
    expect(server.session.state).toBe("CREATED");
    await expect(server.session.listTools()).rejects.toMatchObject({ code: "MCP_SESSION_NOT_READY" });
    const connecting = server.session.connect();
    expect(server.session.state).toBe("CONNECTING");
    await connecting;
    expect(server.session.state).toBe("READY");
    const metadata = await server.session.listTools();
    expect(metadata.map((tool) => tool.name)).toEqual(["crm.read_account"]);
    expect(metadata[0]).toHaveProperty("outputSchema.type", "object");
    expect(metadata[0]).not.toHaveProperty("annotations");
    expect(JSON.parse(JSON.stringify(metadata))).toEqual(metadata);
    const tools = createToolRegistry();
    expect(tools.has(REF)).toBe(false);
    const binding = await createMcpToolBinding({ session: server.session, remoteToolName: "crm.read_account", spec: SPEC });
    expect(binding.spec.permissionClasses).toEqual(["read_only"]);
    expect(binding.spec.capabilityRef).toBe("crm.accounts.read");
    tools.register(binding);
    const result = await executeTool({ tools, request: REQUEST, authorizationContext: AUTH });
    expect(result).toEqual({
      ok: true,
      authorization: { schemaVersion: 1, decision: "ALLOW", principalId: "user.alice", requiredPermissionClasses: ["read_only"], agentCeilingApplied: false },
      result: { schemaVersion: 1, toolExecutionId: "exec.mcp.1", toolRef: REF, output: { id: "a-1", name: "Local Test Account" } },
    });
    if (result.ok) expect(ToolResultSchema.parse(JSON.parse(JSON.stringify(result.result)))).toEqual(result.result);
    expect(server.evidence().calls).toBe(1);
    const { pid } = server.evidence();
    await server.session.close();
    await server.session.close();
    expect(server.session.state).toBe("CLOSED");
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(server.session.connect()).rejects.toMatchObject({ code: "MCP_SESSION_NOT_READY" });
    await expect(server.session.listTools()).rejects.toMatchObject({ code: "MCP_SESSION_NOT_READY" });
    expect(await executeTool({ tools, request: REQUEST, authorizationContext: AUTH })).toMatchObject({ ok: false, failure: { code: "TOOL_EXECUTION_FAILED", handlerFailureCode: "MCP_SESSION_NOT_READY" } });
    expect(server.evidence().calls).toBe(1);
  });

  it.each([
    ["denied", "TOOL_AUTHORIZATION_DENIED"],
    ["unsupported", "TOOL_PERMISSION_UNSUPPORTED"],
    ["invalid", "TOOL_INPUT_SCHEMA_MISMATCH"],
    ["transport-input", "TOOL_INPUT_SCHEMA_MISMATCH"],
  ])("%s AAO request produces %s and zero real remote calls", async (scenario, code) => {
    const spec = scenario === "unsupported" ? { ...SPEC, permissionClasses: ["external_side_effect" as const] } : SPEC;
    const server = await governed("ok", spec);
    const result = await executeTool({
      tools: server.tools,
      request: scenario === "invalid" ? { ...REQUEST, input: { accountId: 42 } } : scenario === "transport-input" ? { ...REQUEST, input: { ...REQUEST.input, command: "untrusted-server", transport: "http" } } : REQUEST,
      authorizationContext: { ...AUTH, grantedPermissionClasses: scenario === "denied" ? [] : spec.permissionClasses },
    });
    expect(result).toMatchObject({ ok: false, failure: { code } });
    expect(server.evidence().calls).toBe(0);
  });

  it.each([
    ["error", "TOOL_EXECUTION_FAILED", "MCP_TOOL_REPORTED_ERROR"],
    ["throw", "TOOL_EXECUTION_FAILED", "MCP_CALL_FAILED"],
    ["disconnect", "TOOL_EXECUTION_FAILED", "MCP_CALL_FAILED"],
    ["text", "TOOL_EXECUTION_FAILED", "MCP_STRUCTURED_OUTPUT_REQUIRED"],
    ["malformed-result", "TOOL_EXECUTION_FAILED", "MCP_CALL_FAILED"],
    ["bad-output", "TOOL_OUTPUT_SCHEMA_MISMATCH", undefined],
  ])("%s remote response fails safely without replay", async (mode, code, handlerFailureCode) => {
    const server = await governed(mode);
    const result = await executeTool({ tools: server.tools, request: REQUEST, authorizationContext: AUTH });
    expect(result).toMatchObject({ ok: false, failure: { code, ...(handlerFailureCode ? { handlerFailureCode } : {}) } });
    expect(JSON.stringify(result)).not.toMatch(/secret-token|private.invalid|server-stack|content|stdio|command/);
    expect(server.evidence().calls).toBe(1);
    if (mode === "disconnect") {
      expect(server.session.state).toBe("CLOSED");
      await executeTool({ tools: server.tools, request: REQUEST, authorizationContext: AUTH });
      expect(server.evidence().calls).toBe(1);
    }
  });

  it("binding rejects unknown remote tools and non-object AAO input schemas before invocation", async () => {
    const server = await governed();
    await expect(createMcpToolBinding({ session: server.session, remoteToolName: "unknown", spec: SPEC })).rejects.toMatchObject({ code: "MCP_TOOL_NOT_AVAILABLE" });
    for (const type of ["string", "number", "array", "null"]) {
      await expect(createMcpToolBinding({ session: server.session, remoteToolName: "crm.read_account", spec: { ...SPEC, inputSchema: { type } } })).rejects.toMatchObject({ code: "MCP_INVALID_BINDING" });
    }
    expect(server.evidence().calls).toBe(0);
  });

  it.each([
    ["duplicate", "MCP_INVALID_DISCOVERY"], ["malformed", "MCP_DISCOVERY_FAILED"],
    ["malformed-nested", "MCP_INVALID_DISCOVERY"],
    ["cycle", "MCP_DISCOVERY_LIMIT_EXCEEDED"], ["limit", "MCP_DISCOVERY_LIMIT_EXCEEDED"],
  ])("%s discovery fails closed with %s", async (mode, code) => {
    const server = fixture(mode);
    await server.session.connect();
    await expect(server.session.listTools()).rejects.toMatchObject({ code });
    expect(server.evidence().calls).toBe(0);
  });

  it("consumes all discovery pages and keeps separate sessions isolated", async () => {
    const first = fixture("pages");
    const second = fixture();
    await Promise.all([first.session.connect(), second.session.connect()]);
    expect((await first.session.listTools()).map((tool) => tool.name)).toEqual(["crm.read_account", "crm.other"]);
    await first.session.close();
    expect(second.session.state).toBe("READY");
    expect(second.evidence().pid).not.toBe(first.evidence().pid);
    expect((await second.session.listTools()).map((tool) => tool.name)).toEqual(["crm.read_account"]);
  });

  it("fails Tools capability negotiation terminally and cleans up the server", async () => {
    const server = fixture("no-tools");
    await expect(server.session.connect()).rejects.toMatchObject({ code: "MCP_TOOLS_UNSUPPORTED" });
    expect(server.session.state).toBe("FAILED");
    expect(() => process.kill(server.evidence().pid, 0)).toThrow();
    await expect(server.session.connect()).rejects.toMatchObject({ code: "MCP_SESSION_NOT_READY" });
  });

  it("workflow tool config cannot select a subprocess or transport", async () => {
    const server = await governed();
    const compiled = compileWorkflowSource(JSON.stringify({
      schemaVersion: 1, id: "test.hostile-config", version: "1.0.0", name: "Hostile config", entryNodeId: "read",
      nodes: [
        { id: "read", kind: "tool", config: { toolRef: REF, inputStateKey: "input", resultStateKey: "result", command: "untrusted-server", transport: "http" } },
        { id: "final", kind: "final_output", config: {} },
      ], edges: [{ sourceNodeId: "read", targetNodeId: "final" }],
    }), "json");
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    const registry = createNodeRegistry();
    registry.register(createToolNodeExecutor({ tools: server.tools, resolveAuthorizationContext: () => AUTH }));
    registry.register(finalOutputExecutor);
    const result = await executeWorkflow({ runId: "run.hostile-config", plan: compiled.plan, initialState: { runId: "run.hostile-config", revision: 0, values: { input: REQUEST.input } }, registry });
    expect(result).toMatchObject({ ok: false, failure: { code: "RUNTIME_PREFLIGHT_FAILED" } });
    expect(server.evidence().calls).toBe(0);
  });

  it.each(["ok", "error"])("generic workflow tool node works with an MCP handler (%s)", async (mode) => {
    const server = await governed(mode);
    const compiled = compileWorkflowSource(JSON.stringify({
      schemaVersion: 1, id: "test.mcp", version: "1.0.0", name: "MCP workflow", entryNodeId: "read",
      nodes: [
        { id: "read", kind: "tool", config: { toolRef: REF, inputStateKey: "input", resultStateKey: "result" } },
        { id: "final", kind: "final_output", config: {} },
      ], edges: [{ sourceNodeId: "read", targetNodeId: "final" }],
    }), "json");
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    const registry = createNodeRegistry();
    registry.register(createToolNodeExecutor({ tools: server.tools, resolveAuthorizationContext: () => AUTH }));
    registry.register(finalOutputExecutor);
    const result = await executeWorkflow({ runId: "run.mcp", plan: compiled.plan, initialState: { runId: "run.mcp", revision: 0, values: { input: REQUEST.input } }, registry, options: { clock: { now: () => "2026-09-28T12:00:00.000Z" } } });
    expect(server.evidence().calls).toBe(1);
    if (mode === "ok") {
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(ToolResultSchema.parse(result.execution.state.values.result).output).toEqual({ id: "a-1", name: "Local Test Account" });
        expect(JSON.stringify(result.latestSnapshot)).not.toMatch(/command|stdio|McpSession|structuredContent|permissionClasses/);
      }
    } else expect(result).toMatchObject({ ok: false, failure: { code: "NODE_EXECUTION_FAILED", executorFailure: { namespace: "tool", code: "TOOL_EXECUTION_FAILED" } } });
  });
});
