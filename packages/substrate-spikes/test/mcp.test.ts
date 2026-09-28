import { afterEach, describe, expect, it } from "vitest";
import { createLocalMcpLab, invokeAuthorizedRead, McpAuthorizationError } from "../src/mcp.js";

describe("historical Sprint 0A MCP toy permission spike (not production authorization)", () => {
  const labs: Awaited<ReturnType<typeof createLocalMcpLab>>[] = [];
  afterEach(async () => { await Promise.all(labs.splice(0).map((lab) => lab.close())); });

  it("discovers a local read-only capability and executes an allowed request", async () => {
    const lab = await createLocalMcpLab(); labs.push(lab);
    const discovered = await lab.client.listTools();
    expect(discovered.tools.map((tool) => tool.name)).toContain("crm.read_account");
    const result = await invokeAuthorizedRead(lab.client, { tool: "crm.read_account", allowed: true }, { accountId: "a-1" });
    expect(result.structuredContent).toEqual({ id: "a-1", name: "Local Test Account" });
    expect(lab.invocations()).toBe(1);
  });

  it("blocks denied or invalid requests before the MCP server executes", async () => {
    const lab = await createLocalMcpLab(); labs.push(lab);
    await expect(invokeAuthorizedRead(lab.client, { tool: "crm.read_account", allowed: false }, { accountId: "a-1" }))
      .rejects.toBeInstanceOf(McpAuthorizationError);
    await expect(invokeAuthorizedRead(lab.client, { tool: "crm.read_account", allowed: true }, { accountId: "" }))
      .rejects.toBeInstanceOf(McpAuthorizationError);
    expect(lab.invocations()).toBe(0);
  });
});
