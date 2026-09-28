import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createToolRegistry, executeTool } from "@aao/tool-runtime";
import { createMcpSession, createMcpToolBinding, MCP_FAILURE_CODES } from "../src/index.js";
import { AUTH, REQUEST, SPEC } from "./fixtures.js";
import { isWireJson } from "../src/json.js";

const sdk = vi.hoisted(() => ({
  connect: vi.fn(), close: vi.fn(), transportClose: vi.fn(), listTools: vi.fn(), callTool: vi.fn(),
  capabilities: vi.fn(), configs: [] as unknown[], clients: [] as unknown[],
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: class {
  constructor() { sdk.clients.push(this); }
  connect = sdk.connect;
  close = sdk.close;
  listTools = sdk.listTools;
  callTool = sdk.callTool;
  getServerCapabilities = sdk.capabilities;
} }));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({ StdioClientTransport: class {
  constructor(config: unknown) { sdk.configs.push(config); }
  close = sdk.transportClose;
} }));
const sessions: ReturnType<typeof createMcpSession>[] = [];
function session() { const created = createMcpSession({ command: "trusted-server", args: ["trusted-arg"] }); sessions.push(created); return created; }
const remote = { name: "crm.read_account", inputSchema: { type: "object" } };
beforeEach(() => {
  vi.resetAllMocks();
  sdk.configs.length = 0; sdk.clients.length = 0;
  sdk.capabilities.mockReturnValue({ tools: {} });
  sdk.listTools.mockResolvedValue({ tools: [remote] });
  sdk.callTool.mockResolvedValue({ content: [], structuredContent: { id: "a-1", name: "Local Test Account" } });
});
afterEach(async () => { await Promise.all(sessions.splice(0).map((created) => created.close())); });

describe("session failure paths and defensive wire boundary", () => {
  it("redacts failed initialization, closes both SDK objects, and never retries", async () => {
    sdk.connect.mockRejectedValue(new Error("secret https://private.invalid stack"));
    const created = session();
    await expect(created.connect()).rejects.toMatchObject({ message: "MCP_CONNECTION_FAILED", code: "MCP_CONNECTION_FAILED" });
    expect(created.state).toBe("FAILED");
    await expect(created.connect()).rejects.toMatchObject({ code: "MCP_SESSION_NOT_READY" });
    expect(sdk.connect).toHaveBeenCalledTimes(1);
    expect(sdk.close).toHaveBeenCalledTimes(1);
    expect(sdk.transportClose).toHaveBeenCalledTimes(1);
    await expect(created.listTools()).rejects.toMatchObject({ code: "MCP_SESSION_NOT_READY" });
    expect(sdk.listTools).not.toHaveBeenCalled();
    expect(sdk.callTool).not.toHaveBeenCalled();
  });

  it("closing during connection prevents READY and cleans up after the handshake settles", async () => {
    let complete!: () => void;
    sdk.connect.mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
    const created = session();
    const connected = created.connect();
    expect(created.state).toBe("CONNECTING");
    await created.close();
    complete();
    await expect(connected).rejects.toMatchObject({ code: "MCP_SESSION_NOT_READY" });
    expect(created.state).toBe("CLOSED");
    expect(sdk.callTool).not.toHaveBeenCalled();
  });

  it("captures only command/args, ignores stderr, and exposes no client, transport or invocation API", async () => {
    const config = { command: "trusted-server", args: ["original"] };
    const created = createMcpSession(config); sessions.push(created);
    config.args[0] = "mutated";
    expect(sdk.configs).toEqual([{ command: "trusted-server", args: ["original"], stderr: "ignore" }]);
    expect(Object.keys(created).sort()).toEqual(["close", "connect", "listTools", "state"]);
    expect(() => createMcpSession({ ...config, env: { TOKEN: "secret" } } as typeof config)).toThrow("MCP_CONNECTION_FAILED");
    await expect(createMcpToolBinding({ session: { ...created }, remoteToolName: remote.name, spec: SPEC })).rejects.toMatchObject({ code: "MCP_INVALID_BINDING" });
  });

  it.each([
    { tools: [{ ...remote, inputSchema: { type: "object", unsafe: new Date() } }] },
    { tools: [{ ...remote, description: 42 }] },
    { tools: [{ ...remote, outputSchema: { type: "number" } }] },
    { tools: [{ ...remote, inputSchema: { type: "object", properties: "malformed" } }] },
    { tools: [{ ...remote, inputSchema: { type: "object", required: [42] } }] },
    { tools: [{ ...remote, inputSchema: { type: "object", properties: { accountId: { type: 42 } } } }] },
    { tools: [remote], nextCursor: "" },
    { tools: [remote, remote] },
  ])("rejects malformed discovery data without leaking it", async (page) => {
    sdk.listTools.mockResolvedValue(page);
    const created = session(); await created.connect();
    await expect(created.listTools()).rejects.toMatchObject({ code: "MCP_INVALID_DISCOVERY" });
    expect(sdk.callTool).not.toHaveBeenCalled();
  });

  it("rejects duplicates across pages and bounds aggregate tools", async () => {
    sdk.listTools.mockResolvedValueOnce({ tools: [remote], nextCursor: "two" }).mockResolvedValueOnce({ tools: [remote] });
    const created = session(); await created.connect();
    await expect(created.listTools()).rejects.toMatchObject({ code: "MCP_INVALID_DISCOVERY" });
    sdk.listTools.mockResolvedValueOnce({ tools: Array.from({ length: 1000 }, (_, index) => ({ ...remote, name: `tool.${index}` })), nextCursor: "two" }).mockResolvedValueOnce({ tools: [remote] });
    await expect(created.listTools()).rejects.toMatchObject({ code: "MCP_DISCOVERY_LIMIT_EXCEEDED" });
  });

  it("defensively clones arguments and returns only structured output", async () => {
    const created = session(); await created.connect();
    const spec = structuredClone(SPEC);
    const binding = await createMcpToolBinding({ session: created, remoteToolName: remote.name, spec });
    spec.permissionClasses[0] = "external_side_effect";
    sdk.callTool.mockImplementation(async (request: { arguments: { accountId: string } }) => {
      request.arguments.accountId = "mutated";
      return { content: [{ type: "text", text: "secret" }], _meta: { secret: "secret" }, structuredContent: { id: "a-1", name: "Local Test Account" } };
    });
    const tools = createToolRegistry(); tools.register(binding);
    const result = await executeTool({ tools, request: REQUEST, authorizationContext: AUTH });
    expect(result.ok).toBe(true);
    expect(REQUEST.input.accountId).toBe("a-1");
    expect(JSON.stringify(result)).not.toMatch(/secret|content|_meta/);
    expect(sdk.callTool).toHaveBeenCalledTimes(1);
  });

  it.each([new Date(), { unsafe: undefined }, { unsafe: NaN }, { unsafe: () => 1 }, { unsafe: new Map() }, null, [1]])("rejects non-JSON or non-object structured output (%s)", async (output) => {
    const created = session(); await created.connect();
    const tools = createToolRegistry(); tools.register(await createMcpToolBinding({ session: created, remoteToolName: remote.name, spec: SPEC }));
    sdk.callTool.mockResolvedValue({ content: [], structuredContent: output });
    expect(await executeTool({ tools, request: REQUEST, authorizationContext: AUTH })).toMatchObject({ ok: false, failure: { code: "TOOL_EXECUTION_FAILED", handlerFailureCode: "MCP_INVALID_RESULT" } });
    expect(sdk.callTool).toHaveBeenCalledTimes(1);
  });

  it("all failure codes meet the Tool Runtime contract", () => {
    for (const code of MCP_FAILURE_CODES) expect(code).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/);
  });

  it("wire guard rejects cycles, accessors, sparse arrays and prototype instances", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const getter = vi.fn(() => "secret");
    const sparseWithProperty = Object.assign(new Array(1), { extra: "lossy" });
    for (const value of [cycle, Object.defineProperty({}, "value", { enumerable: true, get: getter }), new Array(1), sparseWithProperty, new Date(), { bad: BigInt(1) }]) expect(isWireJson(value)).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    expect(isWireJson({ a: [1, null, "safe"] })).toBe(true);
  });
});
