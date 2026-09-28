// Compiled production packages, official SDK, real stdio. Test-only process ledger.
import assert from "node:assert/strict";
import process from "node:process";
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { createMcpSession, createMcpToolBinding } from "../dist/index.js";
import { createToolRegistry, executeTool, ToolResultSchema } from "@aao/tool-runtime";

const directory = mkdtempSync(join(tmpdir(), "aao-mcp-smoke-"));
const ledger = join(directory, "ledger.json");
const session = createMcpSession({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/server.mjs", import.meta.url)), "ok", ledger] });
try {
  await session.connect();
  assert.equal((await session.listTools())[0].name, "crm.read_account");
  const spec = {
    schemaVersion: 1, id: "crm.account.read", version: "1.0.0", name: "Read account",
    inputSchema: { type: "object", properties: { accountId: { type: "string" } }, required: ["accountId"], additionalProperties: false },
    outputSchema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id", "name"], additionalProperties: false },
    permissionClasses: ["read_only"], capabilityRef: "crm.accounts.read",
  };
  const tools = createToolRegistry();
  tools.register(await createMcpToolBinding({ session, remoteToolName: "crm.read_account", spec }));
  const result = await executeTool({
    tools,
    request: { schemaVersion: 1, toolExecutionId: "smoke.mcp.1", toolRef: { id: spec.id, version: spec.version }, input: { accountId: "a-1" } },
    authorizationContext: { schemaVersion: 1, principal: { id: "service.smoke", type: "service" }, grantedPermissionClasses: ["read_only"] },
  });
  assert.equal(result.ok, true);
  assert.equal(result.authorization.decision, "ALLOW");
  assert.deepEqual(ToolResultSchema.parse(result.result).output, { id: "a-1", name: "Local Test Account" });
  assert.equal(JSON.parse(readFileSync(ledger, "utf8")).calls, 1);
} finally {
  await session.close();
  if (existsSync(ledger)) unlinkSync(ledger);
  rmdirSync(directory);
}
process.stdout.write("SPRINT_10_MCP_CONNECTOR_SMOKE_OK\n");
