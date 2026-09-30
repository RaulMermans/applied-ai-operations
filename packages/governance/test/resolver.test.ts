import { describe, expect, it } from "vitest";
import { GovernanceDecisionSchema, ResolvedAuthoritySchema } from "@aao/contracts";
import { createGovernanceRegistry, resolveAuthority } from "../src/index.js";

const actor = { id: "user.alice", type: "user" } as const;
const config = {
  actors: [actor, { id: "user.bob", type: "user" as const }],
  roles: [
    { id: "researcher", version: "1.0.0", permissionClasses: ["read_only" as const] },
    { id: "operator", version: "1.0.0", permissionClasses: ["write_draft" as const, "read_only" as const] },
  ],
  bindings: [
    { id: "alice.operator", actorId: actor.id, roleId: "operator", status: "active" as const },
    { id: "alice.researcher", actorId: actor.id, roleId: "researcher", status: "active" as const },
    { id: "bob.researcher", actorId: "user.bob", roleId: "researcher", status: "active" as const },
  ],
  policies: [{ id: "no.destructive", rules: [{ id: "deny.destructive", effect: "DENY" as const, permissionClasses: ["destructive" as const] }] }],
};

describe("governance compile and resolution", () => {
  it("resolves registered roles, deduplicates grants, and is stable and JSON-safe", () => {
    const registry = createGovernanceRegistry(config);
    const before = JSON.stringify(config);
    const first = resolveAuthority(registry, actor, ["read_only", "write_draft"]);
    const second = resolveAuthority(registry, actor, ["write_draft", "read_only"]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ decision: "ALLOW", actorId: actor.id, authority: { roleIds: ["operator", "researcher"], permissionClasses: ["read_only", "write_draft"], policyRefs: ["no.destructive"] }, reasonCodes: ["GOVERNANCE_ALLOWED"] });
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(GovernanceDecisionSchema.parse(first)).toEqual(first);
    expect(ResolvedAuthoritySchema.parse(first.authority)).toEqual(first.authority);
    expect(JSON.stringify(config)).toBe(before);
    expect(Object.isFrozen(registry.configuration.roles[0])).toBe(true);
    expect(resolveAuthority(registry, { id: "user.bob", type: "user" }, ["write_draft"]).decision).toBe("DENY");
  });

  it("denies unknown, unbound, inactive and malformed actors and permissions", () => {
    const registry = createGovernanceRegistry(config);
    expect(resolveAuthority(registry, { id: "user.mallory", type: "user" }, ["read_only"]).reasonCodes).toEqual(["GOVERNANCE_DEFAULT_DENY"]);
    expect(resolveAuthority(registry, { ...actor, roles: ["operator"] }, ["read_only"]).reasonCodes).toEqual(["GOVERNANCE_INVALID_CONTEXT"]);
    expect(resolveAuthority(registry, actor, ["admin"]).decision).toBe("DENY");
    expect(resolveAuthority(createGovernanceRegistry({ ...config, bindings: [] }), actor, ["read_only"]).decision).toBe("DENY");
    expect(resolveAuthority(createGovernanceRegistry({ ...config, bindings: config.bindings.map((binding) => ({ ...binding, status: "inactive" })) }), actor, ["read_only"]).decision).toBe("DENY");
  });

  it("policy deny overrides grants independent of configuration order", () => {
    const denyDraft = { id: "deny.draft", rules: [{ id: "draft", effect: "DENY", permissionClasses: ["write_draft"] }] };
    const denyRead = { id: "deny.read", rules: [{ id: "read", effect: "DENY", permissionClasses: ["read_only"], roleIds: ["operator"] }] };
    for (const policies of [[denyDraft, denyRead], [denyRead, denyDraft]]) {
      const registry = createGovernanceRegistry({ ...config, policies });
      expect(resolveAuthority(registry, actor, ["read_only"]).authority?.permissionClasses).toEqual([]);
      expect(resolveAuthority(registry, actor, ["write_draft"]).reasonCodes).toEqual(["GOVERNANCE_POLICY_DENY"]);
    }
  });

  it("rejects malformed config before execution", () => {
    for (const bad of [
      { ...config, actors: [actor, actor] },
      { ...config, roles: [config.roles[0], config.roles[0]] },
      { ...config, bindings: [config.bindings[0], config.bindings[0]] },
      { ...config, policies: [config.policies[0], config.policies[0]] },
      { ...config, policies: [config.policies[0], { id: "other", rules: config.policies[0]!.rules }] },
      { ...config, bindings: [{ ...config.bindings[0], roleId: "missing" }] },
      { ...config, bindings: [{ ...config.bindings[0], actorId: "missing" }] },
      { ...config, roles: [{ ...config.roles[0], permissionClasses: ["admin"] }] },
      { ...config, policies: [{ id: "empty", rules: [] }] },
      { ...config, policies: [{ id: "bad", rules: [{ id: "bad", effect: "DENY", permissionClasses: ["read_only"], roleIds: ["missing"] }] }] },
    ]) expect(() => createGovernanceRegistry(bad)).toThrow();
  });

  it("contextual payloads have no path to establish authority", () => {
    const registry = createGovernanceRegistry(config);
    const hostile = { actorId: actor.id, roles: ["operator"], permissions: ["destructive"], policies: [], model: {}, workflowState: {}, toolInput: {}, memory: {}, mcpMetadata: {} };
    expect(resolveAuthority(registry, { id: "user.mallory", type: "user" }, ["read_only", "destructive", hostile] as unknown).decision).toBe("DENY");
    expect(resolveAuthority(registry, { id: "user.mallory", type: "user" }, ["read_only"]).decision).toBe("DENY");
  });
});
