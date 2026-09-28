import { mkdtempSync, readFileSync, unlinkSync, rmdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolSpec } from "@aao/contracts";
import { createMcpSession } from "../src/index.js";

export const REF = { id: "crm.account.read", version: "1.0.0" };
export const SPEC: ToolSpec = {
  schemaVersion: 1, ...REF, name: "Read account", description: "Host policy",
  inputSchema: { type: "object", properties: { accountId: { type: "string", minLength: 1 } }, required: ["accountId"], additionalProperties: false },
  outputSchema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id", "name"], additionalProperties: false },
  permissionClasses: ["read_only"], capabilityRef: "crm.accounts.read",
};
export const AUTH = { schemaVersion: 1 as const, principal: { id: "user.alice", type: "user" as const }, grantedPermissionClasses: ["read_only" as const] };
export const REQUEST = { schemaVersion: 1, toolExecutionId: "exec.mcp.1", toolRef: REF, input: { accountId: "a-1" } };

export function realServer(mode = "ok") {
  const directory = mkdtempSync(join(tmpdir(), "aao-mcp-test-"));
  const ledger = join(directory, "ledger.json");
  const session = createMcpSession({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/server.mjs", import.meta.url)), mode, ledger] });
  return {
    session,
    evidence: () => JSON.parse(readFileSync(ledger, "utf8")) as { calls: number; pid: number },
    async cleanup() {
      await session.close();
      if (existsSync(ledger)) unlinkSync(ledger);
      rmdirSync(directory);
    },
  };
}
