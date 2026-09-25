import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionClass } from "@aao/contracts";
import * as authorization from "@aao/authorization";
import { executeTool } from "../src/executor.js";
import { createToolRegistry } from "../src/registry.js";
import { ToolFailureSchema, type ToolExecutionResult } from "../src/types.js";
import { LOOKUP_REF, SECRET, authContext, buildRequest, buildToolSpec, lookupWorld, spyHandler } from "./fixtures.js";

// Observe (never replace) the one canonical evaluator the Tool Runtime calls.
vi.mock("@aao/authorization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aao/authorization")>();
  return { ...actual, authorize: vi.fn(actual.authorize) };
});
const authorizeSpy = vi.mocked(authorization.authorize);
beforeEach(() => authorizeSpy.mockClear());

function failure(outcome: ToolExecutionResult) {
  if (outcome.ok) throw new Error(`expected failure, got ${JSON.stringify(outcome.result)}`);
  return outcome.failure;
}

function exec(permissionClasses: PermissionClass[], authorizationContext: unknown, request: unknown = buildRequest()) {
  const world = lookupWorld({ spec: { permissionClasses } });
  return { ...world, outcome: executeTool({ request, tools: world.tools, authorizationContext: authorizationContext as never }) };
}

const DENIED = (reason: string) => ({
  code: "TOOL_AUTHORIZATION_DENIED",
  message: 'Tool "local.lookup" version "1.0.0" execution is not authorized.',
  toolExecutionId: "exec.tool.1",
  toolRef: { ...LOOKUP_REF },
  authorizationReasonCode: reason,
});

describe("executeTool — authorization is mandatory", () => {
  it("authorized read_only Tool: handler once, success, ALLOW evidence returned outside the ToolResult", async () => {
    const { handler, outcome } = exec(["read_only"], authContext(["read_only"]));
    const result = await outcome;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(handler.calls).toHaveLength(1);
    expect(result.authorization).toEqual({ schemaVersion: 1, decision: "ALLOW", principalId: "user.alice", requiredPermissionClasses: ["read_only"], agentCeilingApplied: false });
    expect(result.result).not.toHaveProperty("authorization");
    expect(authorizeSpy).toHaveBeenCalledTimes(1);
    expect(authorizeSpy.mock.calls[0]![0]).toEqual({
      schemaVersion: 1,
      action: "tool.execute",
      resource: { type: "tool", id: "local.lookup", version: "1.0.0" },
      requiredPermissionClasses: ["read_only"],
      context: authContext(["read_only"]),
    });
  });

  it("unauthorized (no grants) → TOOL_AUTHORIZATION_DENIED / PERMISSION_NOT_GRANTED; handler 0", async () => {
    const { handler, outcome } = exec(["read_only"], authContext([]));
    const f = failure(await outcome);
    expect(f).toEqual(DENIED("PERMISSION_NOT_GRANTED"));
    expect(handler.calls).toHaveLength(0);
    expect(ToolFailureSchema.parse(JSON.parse(JSON.stringify(f)))).toEqual(f);
  });

  it("no invented hierarchy: a write_draft grant does not authorize a read_only Tool", async () => {
    const { handler, outcome } = exec(["read_only"], authContext(["write_draft"]));
    expect(failure(await outcome).authorizationReasonCode).toBe("PERMISSION_NOT_GRANTED");
    expect(handler.calls).toHaveLength(0);
  });

  it("multiple required permissions must all be granted", async () => {
    expect(failure(await exec(["read_only", "write_draft"], authContext(["read_only"])).outcome).code).toBe("TOOL_AUTHORIZATION_DENIED");
    expect((await exec(["read_only", "write_draft"], authContext(["write_draft", "read_only"])).outcome).ok).toBe(true);
  });

  it.each<[string, unknown]>([
    ["undefined", undefined],
    ["null", null],
  ])("missing context (%s) → TOOL_AUTHORIZATION_REQUIRED; evaluator not consulted; handler 0", async (_label, ctx) => {
    const { handler, outcome } = exec(["read_only"], ctx);
    expect(failure(await outcome)).toEqual({ code: "TOOL_AUTHORIZATION_REQUIRED", message: 'Tool "local.lookup" version "1.0.0" requires an authorization context.', toolExecutionId: "exec.tool.1", toolRef: { ...LOOKUP_REF } });
    expect(handler.calls).toHaveLength(0);
    expect(authorizeSpy).not.toHaveBeenCalled();
  });

  it("omitting the parameter entirely fails closed too (no default context)", async () => {
    const { tools, handler } = lookupWorld();
    const outcome = await executeTool({ request: buildRequest(), tools } as never);
    expect(failure(outcome).code).toBe("TOOL_AUTHORIZATION_REQUIRED");
    expect(handler.calls).toHaveLength(0);
  });

  it.each<[string, unknown]>([
    ["unknown principal type", { ...authContext(["read_only"]), principal: { id: "root", type: "admin" } }],
    ["bypass flag", { ...authContext([]), bypassAuthorization: true }],
    ["allowAll flag", { ...authContext(["read_only"]), allowAll: true }],
    ["malformed grants", { ...authContext([]), grantedPermissionClasses: "read_only" }],
    ["string context", "user.alice"],
    ["function-valued principal", { ...authContext(["read_only"]), principal: () => ({ id: "x", type: "user" }) }],
  ])("malformed context (%s) → TOOL_AUTHORIZATION_DENIED / INVALID_AUTHORIZATION_CONTEXT; handler 0", async (_label, ctx) => {
    const { handler, outcome } = exec(["read_only"], ctx);
    expect(failure(await outcome)).toEqual(DENIED("INVALID_AUTHORIZATION_CONTEXT"));
    expect(handler.calls).toHaveLength(0);
  });

  it.each(["user", "service", "system"] as const)("no implicit superuser: a %s principal without grants is denied", async (type) => {
    const { handler, outcome } = exec(["read_only"], { ...authContext([]), principal: { id: "p.1", type } });
    expect(failure(await outcome).authorizationReasonCode).toBe("PERMISSION_NOT_GRANTED");
    expect(handler.calls).toHaveLength(0);
  });

  it("no retry and no memory: a denial is final for that call, and the next call is evaluated afresh", async () => {
    const { tools, handler } = lookupWorld();
    expect(failure(await executeTool({ request: buildRequest(), tools, authorizationContext: authContext([]) })).code).toBe("TOOL_AUTHORIZATION_DENIED");
    expect(authorizeSpy).toHaveBeenCalledTimes(1);
    expect((await executeTool({ request: buildRequest({ toolExecutionId: "exec.tool.2" }), tools, authorizationContext: authContext(["read_only"]) })).ok).toBe(true);
    expect(failure(await executeTool({ request: buildRequest({ toolExecutionId: "exec.tool.3" }), tools, authorizationContext: authContext([]) })).code).toBe("TOOL_AUTHORIZATION_DENIED");
    expect(authorizeSpy).toHaveBeenCalledTimes(3);
    expect(handler.calls).toHaveLength(1);
  });
});

describe("executeTool — canonical ordering", () => {
  it("authorization runs before input validation: unauthorized + invalid input → authorization denial, not TOOL_INPUT_SCHEMA_MISMATCH", async () => {
    const { handler, outcome } = exec(["read_only"], authContext([]), buildRequest({ input: { query: 42, extra: SECRET } }));
    const f = failure(await outcome);
    expect(f).toEqual(DENIED("PERMISSION_NOT_GRANTED"));
    expect(f).not.toHaveProperty("issues");
    expect(JSON.stringify(f)).not.toMatch(/query|secret|string/i);
    expect(handler.calls).toHaveLength(0);
  });

  it("authorized + invalid input → TOOL_INPUT_SCHEMA_MISMATCH (validation still enforced after ALLOW)", async () => {
    const { handler, outcome } = exec(["read_only"], authContext(["read_only"]), buildRequest({ input: { query: 42 } }));
    expect(failure(await outcome).code).toBe("TOOL_INPUT_SCHEMA_MISMATCH");
    expect(authorizeSpy).toHaveBeenCalledTimes(1);
    expect(handler.calls).toHaveLength(0);
  });

  it.each<[PermissionClass[]]>([[["external_side_effect"]], [["destructive"]], [["sensitive_data"]], [["read_only", "sensitive_data"]]])(
    "support gate before authorization: a %j Tool with a context claiming that grant → TOOL_PERMISSION_UNSUPPORTED; evaluator never called; handler 0",
    async (permissionClasses) => {
      const { handler, outcome } = exec(permissionClasses, authContext(["read_only", "write_draft", "external_side_effect", "destructive", "sensitive_data"]));
      const f = failure(await outcome);
      expect(f.code).toBe("TOOL_PERMISSION_UNSUPPORTED");
      expect(f).not.toHaveProperty("authorizationReasonCode");
      expect(authorizeSpy).not.toHaveBeenCalled();
      expect(handler.calls).toHaveLength(0);
    },
  );

  it("unsupported Tool without any context is still TOOL_PERMISSION_UNSUPPORTED (not an authorization failure)", async () => {
    const { outcome } = exec(["external_side_effect"], undefined);
    expect(failure(await outcome).code).toBe("TOOL_PERMISSION_UNSUPPORTED");
  });

  it("request validation and lookup precede authorization", async () => {
    expect(failure(await exec(["read_only"], authContext([]), { bogus: true }).outcome).code).toBe("INVALID_TOOL_REQUEST");
    expect(failure(await exec(["read_only"], authContext([]), buildRequest({ toolRef: { id: "local.missing", version: "1.0.0" } })).outcome).code).toBe("TOOL_NOT_FOUND");
    expect(authorizeSpy).not.toHaveBeenCalled();
  });

  it("supported vs authorized: a registered, supported read_only Tool is still denied without the grant", async () => {
    const tools = createToolRegistry();
    const handler = spyHandler();
    tools.register({ spec: buildToolSpec(), handler });
    expect(tools.has(LOOKUP_REF)).toBe(true);
    expect(failure(await executeTool({ request: buildRequest(), tools, authorizationContext: authContext([]) })).code).toBe("TOOL_AUTHORIZATION_DENIED");
    expect(handler.calls).toHaveLength(0);
  });
});

describe("executeTool — Agent permission ceiling (the contract future Agent Tool use inherits)", () => {
  it("principal [read_only, write_draft], Agent ceiling [read_only], Tool [write_draft] → DENY AGENT_PERMISSION_CEILING_EXCEEDED; handler 0", async () => {
    const { handler, outcome } = exec(["write_draft"], authContext(["read_only", "write_draft"], { agentCeiling: ["read_only"] }));
    expect(failure(await outcome)).toEqual(DENIED("AGENT_PERMISSION_CEILING_EXCEEDED"));
    expect(handler.calls).toHaveLength(0);
  });

  it("principal [read_only, write_draft], Agent ceiling [read_only], Tool [read_only] → ALLOW with agentCeilingApplied", async () => {
    const result = await exec(["read_only"], authContext(["read_only", "write_draft"], { agentCeiling: ["read_only"] })).outcome;
    expect(result.ok && result.authorization).toEqual({ schemaVersion: 1, decision: "ALLOW", principalId: "user.alice", requiredPermissionClasses: ["read_only"], agentCeilingApplied: true });
  });

  it("the Agent cannot elevate: principal [read_only], ceiling [read_only, write_draft], Tool [write_draft] → PERMISSION_NOT_GRANTED", async () => {
    const { handler, outcome } = exec(["write_draft"], authContext(["read_only"], { agentCeiling: ["read_only", "write_draft"] }));
    expect(failure(await outcome).authorizationReasonCode).toBe("PERMISSION_NOT_GRANTED");
    expect(handler.calls).toHaveLength(0);
  });

  it("the ceiling built from a registered AgentSpec is enforced", async () => {
    const agent = authorization.agentAuthorityFromSpec({ id: "agent.research", version: "1.0.0", permissionClasses: ["read_only"] });
    const { outcome } = exec(["write_draft"], { ...authContext(["read_only", "write_draft"]), agent });
    expect(failure(await outcome).authorizationReasonCode).toBe("AGENT_PERMISSION_CEILING_EXCEEDED");
  });
});

describe("executeTool — nothing but the host context grants authority", () => {
  it("Tool input cannot self-authorize", async () => {
    const tools = createToolRegistry();
    const handler = spyHandler(() => ({ ok: true, output: { items: [] } }));
    tools.register({ spec: buildToolSpec({ inputSchema: { type: "object" } }), handler });
    const input = { grantedPermissionClasses: ["read_only", "write_draft"], authorizationContext: authContext(["read_only", "write_draft"]), principal: { id: "root", type: "system" }, allow: true };
    const outcome = await executeTool({ request: buildRequest({ input }), tools, authorizationContext: authContext([]) });
    expect(failure(outcome).authorizationReasonCode).toBe("PERMISSION_NOT_GRANTED");
    expect(handler.calls).toHaveLength(0);
  });

  it("authority cannot be smuggled into the request envelope", async () => {
    const { handler, outcome } = exec(["read_only"], authContext([]), buildRequest({ authorizationContext: authContext(["read_only"]) }));
    expect(failure(await outcome).code).toBe("INVALID_TOOL_REQUEST");
    expect(handler.calls).toHaveLength(0);
  });

  it("a Tool handler's output cannot grant authority to a later call", async () => {
    const tools = createToolRegistry();
    const granting = spyHandler(() => ({ ok: true, output: { permissions: ["write_draft"], grantedPermissionClasses: ["write_draft"] } }));
    const drafting = spyHandler(() => ({ ok: true, output: { items: [] } }));
    tools.register({ spec: buildToolSpec({ id: "local.grant", outputSchema: { type: "object" } }), handler: granting });
    tools.register({ spec: buildToolSpec({ id: "local.draft", permissionClasses: ["write_draft"] }), handler: drafting });
    const ctx = authContext(["read_only"]);
    const first = await executeTool({ request: buildRequest({ toolRef: { id: "local.grant", version: "1.0.0" } }), tools, authorizationContext: ctx });
    expect(first.ok && first.result.output).toEqual({ permissions: ["write_draft"], grantedPermissionClasses: ["write_draft"] });
    const second = await executeTool({ request: buildRequest({ toolExecutionId: "exec.tool.2", toolRef: { id: "local.draft", version: "1.0.0" } }), tools, authorizationContext: ctx });
    expect(failure(second).authorizationReasonCode).toBe("PERMISSION_NOT_GRANTED");
    expect(drafting.calls).toHaveLength(0);
    expect(ctx.grantedPermissionClasses).toEqual(["read_only"]);
  });

  it("executeTool never mutates the caller's context", async () => {
    const ctx = authContext(["read_only"], { agentCeiling: ["read_only"] });
    const before = JSON.parse(JSON.stringify(ctx));
    await exec(["read_only"], ctx).outcome;
    expect(ctx).toEqual(before);
  });

  it("the handler never receives the authorization context", async () => {
    const { handler, outcome } = exec(["read_only"], authContext(["read_only"]));
    await outcome;
    expect(Object.keys(handler.calls[0]!).sort()).toEqual(["input", "tool", "toolExecutionId"]);
  });
});
