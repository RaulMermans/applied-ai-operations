import { describe, expect, it } from "vitest";
import { agentAuthorityFromSpec, authorizationContextFromAuthority } from "@aao/authorization";
import { createGovernanceRegistry, resolveAuthority } from "@aao/governance";
import { executeTool } from "../src/executor.js";
import { buildRequest, lookupWorld } from "./fixtures.js";

const actor = { id: "user.alice", type: "user" } as const;
function governed(policies: unknown[] = []) {
  return createGovernanceRegistry({
    actors: [actor, { id: "user.bob", type: "user" }],
    roles: [{ id: "operator", version: "1.0.0", permissionClasses: ["read_only", "write_draft", "external_side_effect"] }],
    bindings: [{ id: "alice.operator", actorId: actor.id, roleId: "operator", status: "active" }],
    policies,
  });
}
function context(registry: ReturnType<typeof governed>, who: unknown, requested: string[], agent = false) {
  const decision = resolveAuthority(registry, who, requested);
  if (!decision.authority) return { decision, authorizationContext: undefined };
  return {
    decision,
    authorizationContext: authorizationContextFromAuthority(decision.authority, agent ? agentAuthorityFromSpec({ id: "agent.research", version: "1.0.0", permissionClasses: ["read_only"] }) : undefined),
  };
}

describe("governance through existing Tool authorization", () => {
  it("allows a local Tool exactly once with resolved actor, roles, policies and validated output", async () => {
    const { tools, handler } = lookupWorld();
    const { decision, authorizationContext } = context(governed(), actor, ["read_only"]);
    expect(decision).toMatchObject({ decision: "ALLOW", actorId: "user.alice", authority: { roleIds: ["operator"], permissionClasses: ["external_side_effect", "read_only", "write_draft"], policyRefs: [] } });
    const result = await executeTool({ tools, request: buildRequest(), authorizationContext: authorizationContext! });
    expect(result).toMatchObject({ ok: true, authorization: { decision: "ALLOW", principalId: "user.alice" }, result: { output: { items: ["alpha-result"] } } });
    expect(handler.calls).toHaveLength(1);
  });

  it("denies an unbound actor before execution", async () => {
    const { tools, handler } = lookupWorld();
    const { decision, authorizationContext } = context(governed(), { id: "user.bob", type: "user" }, ["read_only"]);
    expect(decision.decision).toBe("DENY");
    expect((await executeTool({ tools, request: buildRequest(), authorizationContext: authorizationContext! })).ok).toBe(false);
    expect(handler.calls).toHaveLength(0);
  });

  it("policy deny, Agent ceiling and Tool support gate all remain effective", async () => {
    const { tools: draftTools, handler: draftHandler } = lookupWorld({ spec: { permissionClasses: ["write_draft"] } });
    const policy = { id: "no.draft", rules: [{ id: "deny.draft", effect: "DENY", permissionClasses: ["write_draft"] }] };
    const denied = context(governed([policy]), actor, ["write_draft"]);
    expect(denied.decision.reasonCodes).toEqual(["GOVERNANCE_POLICY_DENY"]);
    expect(await executeTool({ tools: draftTools, request: buildRequest(), authorizationContext: denied.authorizationContext! })).toMatchObject({ ok: false, failure: { code: "TOOL_AUTHORIZATION_DENIED", authorizationReasonCode: "PERMISSION_NOT_GRANTED" } });
    expect(draftHandler.calls).toHaveLength(0);
    const agent = context(governed(), actor, ["write_draft"], true);
    expect(await executeTool({ tools: draftTools, request: buildRequest(), authorizationContext: agent.authorizationContext! })).toMatchObject({ ok: false, failure: { code: "TOOL_AUTHORIZATION_DENIED", authorizationReasonCode: "AGENT_PERMISSION_CEILING_EXCEEDED" } });
    expect(draftHandler.calls).toHaveLength(0);
    const { tools: unsupportedTools, handler: unsupportedHandler } = lookupWorld({ spec: { permissionClasses: ["external_side_effect"] } });
    const supported = context(governed(), actor, ["external_side_effect"]);
    expect(await executeTool({ tools: unsupportedTools, request: buildRequest(), authorizationContext: supported.authorizationContext! })).toMatchObject({ ok: false, failure: { code: "TOOL_PERMISSION_UNSUPPORTED" } });
    expect(unsupportedHandler.calls).toHaveLength(0);
  });
});
