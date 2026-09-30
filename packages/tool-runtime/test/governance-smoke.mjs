import process from "node:process";
import { createGovernanceRegistry, resolveAuthority } from "@aao/governance";
import { authorizationContextFromAuthority } from "@aao/authorization";
import { createToolRegistry, executeTool, ToolResultSchema } from "@aao/tool-runtime";

const registry = createGovernanceRegistry({
  actors: [{ id: "user.alice", type: "user" }, { id: "user.bob", type: "user" }],
  roles: [{ id: "researcher", version: "1.0.0", permissionClasses: ["read_only"] }],
  bindings: [{ id: "alice.researcher", actorId: "user.alice", roleId: "researcher", status: "active" }],
  policies: [],
});
let calls = 0;
const tools = createToolRegistry();
tools.register({
  spec: {
    schemaVersion: 1, id: "local.lookup", version: "1.0.0", name: "Local lookup",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    outputSchema: { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false },
    permissionClasses: ["read_only"],
  },
  handler: { async execute({ input }) { calls++; return { ok: true, output: { result: input.query } }; } },
});
const request = { schemaVersion: 1, toolExecutionId: "exec.smoke.1", toolRef: { id: "local.lookup", version: "1.0.0" }, input: { query: "alpha" } };
for (const [id, expected] of [["user.alice", "ALLOW"], ["user.bob", "DENY"]]) {
  const decision = resolveAuthority(registry, { id, type: "user" }, ["read_only"]);
  if (decision.decision !== expected || !decision.authority) throw new Error("Unexpected governance decision");
  const result = await executeTool({ tools, request: { ...request, toolExecutionId: `exec.${id}` }, authorizationContext: authorizationContextFromAuthority(decision.authority) });
  if (expected === "ALLOW") {
    if (!result.ok || result.authorization.decision !== "ALLOW" || ToolResultSchema.parse(result.result).output.result !== "alpha") throw new Error("Invalid authorized result");
  } else if (result.ok) throw new Error("Denied actor executed Tool");
}
if (calls !== 1) throw new Error(`Expected one handler call, got ${calls}`);
process.stdout.write("SPRINT_11_GOVERNANCE_SMOKE_OK\n");
