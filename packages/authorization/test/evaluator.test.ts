import { describe, expect, it, vi } from "vitest";
import type { PermissionClass } from "@aao/contracts";
import { agentAuthorityFromSpec, authorize } from "../src/evaluator.js";
import { AuthorizationDecisionSchema, AuthorizationRequestSchema } from "../src/types.js";
import { context, request } from "./fixtures.js";

type Case = [PermissionClass[], PermissionClass[], "ALLOW" | "DENY"];

describe("authorize — principal grants (required ⊆ granted)", () => {
  it.each<Case>([
    [["read_only"], ["read_only"], "ALLOW"],
    [["read_only"], ["read_only", "write_draft"], "ALLOW"],
    [["read_only", "write_draft"], ["read_only", "write_draft"], "ALLOW"],
    [["read_only", "write_draft"], ["write_draft", "read_only", "sensitive_data"], "ALLOW"],
    [["read_only"], [], "DENY"],
    [["read_only", "write_draft"], ["read_only"], "DENY"],
    [["read_only", "write_draft"], ["write_draft"], "DENY"],
  ])("Tool %j, principal %j → %s", (required, granted, expected) => {
    const decision = authorize(request(required, context(granted)));
    expect(decision.decision).toBe(expected);
    if (expected === "ALLOW") {
      expect(decision).toEqual({ schemaVersion: 1, decision: "ALLOW", principalId: "user.alice", requiredPermissionClasses: required, agentCeilingApplied: false });
    } else {
      expect(decision).toEqual({ schemaVersion: 1, decision: "DENY", reasonCode: "PERMISSION_NOT_GRANTED", principalId: "user.alice", requiredPermissionClasses: required, agentCeilingApplied: false });
    }
  });

  it.each<[PermissionClass, PermissionClass]>([
    ["read_only", "write_draft"],
    ["write_draft", "read_only"],
    ["read_only", "external_side_effect"],
    ["read_only", "destructive"],
    ["read_only", "sensitive_data"],
  ])("no invented hierarchy: requiring %s is not satisfied by %s", (required, granted) => {
    expect(authorize(request([required], context([granted])))).toMatchObject({ decision: "DENY", reasonCode: "PERMISSION_NOT_GRANTED" });
  });

  it.each(["user", "service", "system"] as const)("no implicit superuser: a %s principal with no grants is denied", (type) => {
    const ctx = { ...context([]), principal: { id: "principal.x", type } };
    expect(authorize(request(["read_only"], ctx))).toMatchObject({ decision: "DENY", reasonCode: "PERMISSION_NOT_GRANTED", principalId: "principal.x" });
  });

  it("the evaluator decides only on permission sets: a supported-gate-blocked class is still just a grant question here", () => {
    // Runtime support is a separate gate the Tool Runtime enforces *before* authorization.
    expect(authorize(request(["external_side_effect"], context(["external_side_effect"]))).decision).toBe("ALLOW");
  });
});

describe("authorize — Agent permission ceiling (required ⊆ grants ∩ ceiling)", () => {
  it("principal [read_only, write_draft], ceiling [read_only], Tool [read_only] → ALLOW", () => {
    expect(authorize(request(["read_only"], context(["read_only", "write_draft"], ["read_only"])))).toEqual({
      schemaVersion: 1,
      decision: "ALLOW",
      principalId: "user.alice",
      requiredPermissionClasses: ["read_only"],
      agentCeilingApplied: true,
    });
  });

  it("principal [read_only, write_draft], ceiling [read_only], Tool [write_draft] → DENY AGENT_PERMISSION_CEILING_EXCEEDED", () => {
    expect(authorize(request(["write_draft"], context(["read_only", "write_draft"], ["read_only"])))).toEqual({
      schemaVersion: 1,
      decision: "DENY",
      reasonCode: "AGENT_PERMISSION_CEILING_EXCEEDED",
      principalId: "user.alice",
      requiredPermissionClasses: ["write_draft"],
      agentCeilingApplied: true,
    });
  });

  it("the Agent cannot expand principal authority: principal [read_only], ceiling [read_only, write_draft], Tool [write_draft] → DENY PERMISSION_NOT_GRANTED", () => {
    expect(authorize(request(["write_draft"], context(["read_only"], ["read_only", "write_draft"])))).toMatchObject({ decision: "DENY", reasonCode: "PERMISSION_NOT_GRANTED", agentCeilingApplied: true });
  });

  it("multiple required permissions must satisfy both boundaries", () => {
    expect(authorize(request(["read_only", "write_draft"], context(["read_only", "write_draft"], ["read_only", "write_draft"]))).decision).toBe("ALLOW");
    expect(authorize(request(["read_only", "write_draft"], context(["read_only", "write_draft"], ["write_draft"])))).toMatchObject({ reasonCode: "AGENT_PERMISSION_CEILING_EXCEEDED" });
  });

  it("agentAuthorityFromSpec takes the ceiling from the registered canonical AgentSpec only", () => {
    const spec = { schemaVersion: 1 as const, id: "agent.research", version: "1.0.0", name: "Research", skillRefs: [], toolRefs: [], permissionClasses: ["read_only" as const] };
    const agent = agentAuthorityFromSpec(spec);
    expect(agent).toEqual({ agentRef: { id: "agent.research", version: "1.0.0" }, permissionCeiling: ["read_only"] });
    spec.permissionClasses.push("write_draft" as never);
    expect(agent.permissionCeiling).toEqual(["read_only"]);
    expect(authorize(request(["write_draft"], { ...context(["read_only", "write_draft"]), agent })).decision).toBe("DENY");
  });
});

describe("authorize — fail closed on malformed input", () => {
  it.each<[string, unknown]>([
    ["missing context", undefined],
    ["null context", null],
    ["missing principal", { schemaVersion: 1, grantedPermissionClasses: ["read_only"] }],
    ["invalid principal id", { ...context(["read_only"]), principal: { id: "has space", type: "user" } }],
    ["empty principal id", { ...context(["read_only"]), principal: { id: "", type: "user" } }],
    ["unknown principal type", { ...context(["read_only"]), principal: { id: "user.alice", type: "admin" } }],
    ["principal with extra field", { ...context(["read_only"]), principal: { id: "user.alice", type: "user", admin: true } }],
    ["grants not an array", { ...context([]), grantedPermissionClasses: "read_only" }],
    ["unknown permission class", { ...context([]), grantedPermissionClasses: ["read_only", "superuser"] }],
    ["duplicate grants", { ...context([]), grantedPermissionClasses: ["read_only", "read_only"] }],
    ["missing grants", { schemaVersion: 1, principal: { id: "user.alice", type: "user" } }],
    ["bypass field allowAll", { ...context([]), allowAll: true }],
    ["bypass field admin", { ...context([]), admin: true }],
    ["bypass field bypassAuthorization", { ...context([]), bypassAuthorization: true }],
    ["wrong schemaVersion", { ...context(["read_only"]), schemaVersion: 2 }],
    ["empty Agent ceiling", context(["read_only"], [])],
    ["duplicate Agent ceiling", context(["read_only"], ["read_only", "read_only"])],
    ["malformed Agent ceiling", { ...context(["read_only"]), agent: { agentRef: { id: "agent.a", version: "1" }, permissionCeiling: "read_only" } }],
    ["invalid Agent reference", { ...context(["read_only"]), agent: { agentRef: { id: "../agent" , version: "1" }, permissionCeiling: ["read_only"] } }],
    ["Agent reference without version", { ...context(["read_only"]), agent: { agentRef: { id: "agent.a" }, permissionCeiling: ["read_only"] } }],
    ["Agent with extra field", { ...context(["read_only"]), agent: { agentRef: { id: "agent.a", version: "1" }, permissionCeiling: ["read_only"], grants: ["write_draft"] } }],
    ["Date context", new Date(0)],
    ["array context", [context(["read_only"])]],
  ])("%s → DENY INVALID_AUTHORIZATION_CONTEXT", (_label, ctx) => {
    const decision = authorize(request(["read_only"], ctx));
    expect(decision).toEqual({ schemaVersion: 1, decision: "DENY", reasonCode: "INVALID_AUTHORIZATION_CONTEXT", requiredPermissionClasses: ["read_only"] });
  });

  it.each<[string, unknown]>([
    ["non-object", "tool.execute"],
    ["unknown action", request(["read_only"], context(["read_only"]), { action: "tool.delete" })],
    ["wrong resource type", request(["read_only"], context(["read_only"]), { resource: { type: "agent", id: "a", version: "1" } })],
    ["empty required permissions", request([], context(["read_only"]))],
    ["duplicate required permissions", request(["read_only", "read_only"], context(["read_only"]))],
    ["unknown required permission", request(["root" as never], context(["read_only"]))],
    ["extra request field", request(["read_only"], context(["read_only"]), { override: "ALLOW" })],
  ])("malformed request (%s) → DENY INVALID_AUTHORIZATION_REQUEST", (_label, req) => {
    expect(authorize(req)).toEqual({ schemaVersion: 1, decision: "DENY", reasonCode: "INVALID_AUTHORIZATION_REQUEST" });
  });
});

describe("authorize — determinism and serialization", () => {
  it("same request → same decision; no clock or randomness dependency", () => {
    const req = request(["read_only"], context(["read_only"], ["read_only"]));
    const first = authorize(req);
    const random = vi.spyOn(Math, "random").mockReturnValue(0.123);
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      expect(authorize(req)).toEqual(first);
    } finally {
      random.mockRestore();
      now.mockRestore();
    }
  });

  it("does not mutate the request, and the decision does not alias it", () => {
    const req = request(["read_only"], context(["read_only"]));
    const snapshot = JSON.parse(JSON.stringify(req));
    const decision = authorize(req);
    expect(req).toEqual(snapshot);
    if (decision.decision === "ALLOW") decision.requiredPermissionClasses.push("write_draft");
    expect(req.requiredPermissionClasses).toEqual(["read_only"]);
  });

  it("keeps no memory between calls (no cached verdicts)", () => {
    expect(authorize(request(["read_only"], context(["read_only"]))).decision).toBe("ALLOW");
    expect(authorize(request(["read_only"], context([]))).decision).toBe("DENY");
    expect(authorize(request(["read_only"], context(["read_only"]))).decision).toBe("ALLOW");
  });

  it("requests and decisions are JSON-safe and round-trip through their schemas", () => {
    const req = request(["read_only"], context(["read_only"], ["read_only"]));
    expect(AuthorizationRequestSchema.parse(JSON.parse(JSON.stringify(req)))).toEqual(req);
    for (const decision of [authorize(req), authorize(request(["write_draft"], context(["read_only"]))), authorize(request(["read_only"], null)), authorize("x")]) {
      expect(AuthorizationDecisionSchema.parse(JSON.parse(JSON.stringify(decision)))).toEqual(decision);
    }
  });

  it("the decision never carries the grants list, Agent reference, or free-text explanation", () => {
    const decision = authorize(request(["write_draft"], context(["read_only", "sensitive_data"], ["read_only"])));
    expect(JSON.stringify(decision)).not.toMatch(/sensitive_data|agent\.research|message|explanation/);
  });

  it("AuthorizationDecisionSchema is strict and has only ALLOW/DENY (no REQUIRE_APPROVAL here)", () => {
    expect(AuthorizationDecisionSchema.safeParse({ schemaVersion: 1, decision: "REQUIRE_APPROVAL", reasonCode: "PERMISSION_NOT_GRANTED" }).success).toBe(false);
    expect(AuthorizationDecisionSchema.safeParse({ schemaVersion: 1, decision: "DENY", reasonCode: "because I said so" }).success).toBe(false);
    expect(AuthorizationDecisionSchema.safeParse({ schemaVersion: 1, decision: "ALLOW", principalId: "u", requiredPermissionClasses: ["read_only"], agentCeilingApplied: false, note: "x" }).success).toBe(false);
  });
});
