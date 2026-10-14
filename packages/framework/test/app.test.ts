import { describe, expect, it } from "vitest";
import { compileWorkflow } from "@aao/workflow-dsl";
import { AAOFrameworkError, createAAO, defineGovernance, defineTool, defineWorkflow, type AAOOptions, type WorkflowExecutionResult } from "../src/index.js";
import { alice, approvalWorkflowInput, bob, countingTool, governanceInput, initialState, mallory, robot, sessions, testClock, toolWorkflowInput } from "./support.js";

function frameworkError(run: () => unknown): AAOFrameworkError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AAOFrameworkError);
    return error as AAOFrameworkError;
  }
  throw new Error("expected an AAOFrameworkError");
}

function appWith(options: Partial<AAOOptions> & { principals?: Record<string, typeof alice> } = {}) {
  const host = sessions(options.principals ?? {});
  const draft = countingTool("crm.draft");
  const app = createAAO({ governance: defineGovernance(governanceInput()), principalForRun: host.principalForRun, tools: [defineTool(draft)], clock: testClock(), ...options });
  return { app, host, draft };
}

const failureOf = (result: WorkflowExecutionResult) => (result.ok ? undefined : { code: result.failure.code, executor: result.failure.executorFailure?.code, details: result.failure.details });

describe("createAAO: explicit, validated, construction-time composition", () => {
  it("constructs a frozen application with the framework API version", () => {
    const { app } = appWith();
    expect(app.apiVersion).toBe(1);
    expect(Object.isFrozen(app) && Object.isFrozen(app.approvals)).toBe(true);
    expect(Object.keys(app).sort()).toEqual(["apiVersion", "approvals", "prepareWorkflow"]);
  });

  it("requires a trusted principalForRun: there is no default identity", () => {
    const error = frameworkError(() => createAAO({ governance: governanceInput() } as AAOOptions));
    expect(error.code).toBe("FRAMEWORK_PRINCIPAL_UNAVAILABLE");
    expect(frameworkError(() => createAAO(undefined as never)).code).toBe("FRAMEWORK_INVALID_CONFIGURATION");
  });

  it("invalid configuration fails construction with bounded, safe errors", () => {
    const badGovernance = governanceInput();
    badGovernance.bindings[0]!.actorId = "user.nobody";
    const governanceError = frameworkError(() => createAAO({ governance: badGovernance, principalForRun: () => alice }));
    expect(governanceError.code).toBe("FRAMEWORK_INVALID_CONFIGURATION");
    expect(governanceError.message).toBe("FRAMEWORK_INVALID_CONFIGURATION: governance: INVALID_GOVERNANCE_CONFIGURATION: unknown binding reference");
    const schemaError = frameworkError(() => createAAO({ governance: { ...governanceInput(), actors: "everyone" } as never, principalForRun: () => alice }));
    expect(schemaError.message).toBe("FRAMEWORK_INVALID_CONFIGURATION: governance does not satisfy its canonical AAO schema");
    expect(schemaError.diagnostics).toEqual([expect.objectContaining({ code: "SCHEMA_VALIDATION_ERROR", path: "actors" })]);
    expect(frameworkError(() => createAAO({ governance: governanceInput(), principalForRun: () => alice, tools: "crm.draft" as never })).code).toBe("FRAMEWORK_INVALID_CONFIGURATION");
    expect(frameworkError(() => createAAO({ governance: governanceInput(), principalForRun: () => alice, clock: {} as never })).code).toBe("FRAMEWORK_INVALID_CONFIGURATION");
  });

  it("a duplicate Tool id@version fails construction — never a silent replacement", () => {
    const error = frameworkError(() => createAAO({ governance: governanceInput(), principalForRun: () => alice, tools: [defineTool(countingTool("crm.draft")), defineTool(countingTool("crm.draft"))] }));
    expect(error.code).toBe("FRAMEWORK_INVALID_CONFIGURATION");
    expect(error.message).toContain('tool "crm.draft" version "1.0.0" is already registered');
  });

  it("a hand-built Tool object (not from defineTool) passes through the same canonical registration gates", () => {
    const forged = { spec: { ...countingTool("crm.forged").spec, permissionClasses: ["root"] }, handler: { execute: async () => ({ ok: true, output: {} }) } };
    expect(frameworkError(() => createAAO({ governance: governanceInput(), principalForRun: () => alice, tools: [forged as never] })).code).toBe("FRAMEWORK_INVALID_CONFIGURATION");
  });
});

describe("prepareWorkflow: compile through the canonical compiler only", () => {
  it("returns an immutable PreparedWorkflow with a deterministic plan fingerprint", () => {
    const { app } = appWith();
    const prepared = app.prepareWorkflow(defineWorkflow(approvalWorkflowInput()));
    expect(Object.isFrozen(prepared) && Object.isFrozen(prepared.workflow)).toBe(true);
    expect(prepared.planFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(appWith().app.prepareWorkflow(approvalWorkflowInput()).planFingerprint).toBe(prepared.planFingerprint);
    expect(app.prepareWorkflow(toolWorkflowInput()).planFingerprint).not.toBe(prepared.planFingerprint);
    expect(Object.keys(prepared).sort()).toEqual(["continue", "execute", "planFingerprint", "workflow"]);
  });

  it("a graph error is FRAMEWORK_WORKFLOW_COMPILE_FAILED carrying the compiler's exact canonical diagnostics", () => {
    const input = approvalWorkflowInput();
    input.nodes.push({ id: "approve", kind: "final_output", config: {} }, { id: "orphan", kind: "final_output", config: {} });
    const error = frameworkError(() => appWith().app.prepareWorkflow(input));
    expect(error.code).toBe("FRAMEWORK_WORKFLOW_COMPILE_FAILED");
    const canonical = compileWorkflow(defineWorkflow(input));
    expect(canonical.ok).toBe(false);
    expect(error.diagnostics).toEqual(canonical.ok ? [] : canonical.diagnostics);
    expect(error.diagnostics.map((entry) => entry.code)).toEqual(expect.arrayContaining(["DUPLICATE_NODE_ID", "UNREACHABLE_NODE"]));
    expect(error.message).not.toMatch(/\n\s+at\s/);
  });

  it("node kinds outside the stable V1 scope are refused at preparation, not faked", () => {
    const input = toolWorkflowInput();
    input.entryNodeId = "think";
    input.nodes.unshift({ id: "think", kind: "model", config: {} }, { id: "act", kind: "agent", config: {} }, { id: "calc", kind: "deterministic", config: {} });
    input.edges.unshift({ sourceNodeId: "think", targetNodeId: "act" }, { sourceNodeId: "act", targetNodeId: "calc" }, { sourceNodeId: "calc", targetNodeId: "draft" });
    const error = frameworkError(() => appWith().app.prepareWorkflow(input));
    expect(error.code).toBe("FRAMEWORK_FEATURE_NOT_AVAILABLE");
    expect(error.diagnostics.map((entry) => entry.nodeId)).toEqual(["think", "act", "calc"]);
  });
});

describe("execution: canonical Runtime results, never rewrapped", () => {
  it("runs a Tool workflow to completion", async () => {
    const { app, draft } = appWith({ principals: { "run-1": alice } });
    const result = await app.prepareWorkflow(toolWorkflowInput()).execute({ runId: "run-1", initialState: initialState("run-1") });
    expect(result.ok && result.execution.run.status).toBe("COMPLETED");
    expect(result.ok && result.execution.state.values.draft).toMatchObject({ output: { id: "crm.draft:acme" } });
    expect(draft.calls()).toBe(1);
  });

  it("a handler failure stays the canonical NODE_EXECUTION_FAILED with Tool causality — not a framework error", async () => {
    const failing = countingTool("crm.draft", ["write_draft"], () => ({ ok: false, code: "UPSTREAM_REJECTED" }));
    const host = sessions({ "run-f": alice });
    const app = createAAO({ governance: governanceInput(), principalForRun: host.principalForRun, tools: [defineTool(failing)] });
    const result = await app.prepareWorkflow(toolWorkflowInput()).execute({ runId: "run-f", initialState: initialState("run-f") });
    expect(failureOf(result)).toMatchObject({ code: "NODE_EXECUTION_FAILED", executor: "TOOL_EXECUTION_FAILED" });
    expect(result.ok ? undefined : result.failure.executorFailure).toEqual({ namespace: "tool", code: "TOOL_EXECUTION_FAILED", category: "EXECUTION" });
  });

  it("invalid Runtime input is returned as INVALID_RUNTIME_INPUT, not thrown", async () => {
    const { app } = appWith({ principals: { "run-1": alice } });
    const result = await app.prepareWorkflow(toolWorkflowInput()).execute({ runId: "run-1", initialState: initialState("run-other") });
    expect(failureOf(result)?.code).toBe("INVALID_RUNTIME_INPUT");
  });

  it("a Tool that is not registered fails Runtime preflight canonically", async () => {
    const { app } = appWith({ principals: { "run-1": alice } });
    const result = await app.prepareWorkflow(toolWorkflowInput("crm.unknown")).execute({ runId: "run-1", initialState: initialState("run-1") });
    expect(failureOf(result)?.code).toBe("RUNTIME_PREFLIGHT_FAILED");
    expect(JSON.stringify(failureOf(result)?.details)).toContain("TOOL_NOT_FOUND");
  });

  it.each([["external_side_effect"], ["destructive"], ["sensitive_data"], ["read_only", "sensitive_data"]] as const)("permission classes %s stay unsupported: preflight refuses, handler never runs, whatever the grants", async (...classes) => {
    const tool = countingTool("risky.tool", [...classes]);
    const host = sessions({ "run-u": alice });
    const app = createAAO({ governance: governanceInput(), principalForRun: host.principalForRun, tools: [defineTool(tool)] });
    const result = await app.prepareWorkflow(toolWorkflowInput("risky.tool")).execute({ runId: "run-u", initialState: initialState("run-u") });
    expect(failureOf(result)?.code).toBe("RUNTIME_PREFLIGHT_FAILED");
    expect(JSON.stringify(failureOf(result)?.details)).toContain("TOOL_PERMISSION_UNSUPPORTED");
    expect(tool.calls()).toBe(0);
  });
});

describe("Approval through the canonical Approval Engine", () => {
  async function waiting(runId = "run-a") {
    const setup = appWith({ principals: { [runId]: alice } });
    const prepared = setup.app.prepareWorkflow(approvalWorkflowInput());
    const first = await prepared.execute({ runId, initialState: initialState(runId) });
    if (!first.ok || first.execution.wait === undefined) throw new Error("expected a wait");
    return { ...setup, prepared, first, approvalId: first.execution.wait.referenceId };
  }

  it("request → wait → approve → continue → Tool runs once → COMPLETED", async () => {
    const { app, prepared, first, approvalId, draft } = await waiting();
    expect(first.execution.run.status).toBe("WAITING_FOR_APPROVAL");
    expect(app.approvals.get(approvalId)).toMatchObject({ status: "pending", requestedBy: alice, requiredApproverRoleIds: ["manager"] });
    expect(draft.calls()).toBe(0);
    const record = app.approvals.approve(approvalId, bob);
    expect(Object.isFrozen(record)).toBe(true);
    const final = await prepared.continue(first.execution);
    expect(final.ok && final.execution.run.status).toBe("COMPLETED");
    expect(draft.calls()).toBe(1);
  });

  it("continuing while pending preserves the canonical APPROVAL_STILL_PENDING failure — no polling, success, or auto-approval", async () => {
    const { app, prepared, first, approvalId, draft } = await waiting();
    const result = await prepared.continue(first.execution);
    expect(failureOf(result)?.code).toBe("APPROVAL_STILL_PENDING");
    expect(app.approvals.get(approvalId)?.status).toBe("pending");
    expect(draft.calls()).toBe(0);
  });

  it("rejection fails the Run canonically and blocks the Tool", async () => {
    const { app, prepared, first, approvalId, draft } = await waiting();
    app.approvals.reject(approvalId, bob);
    const result = await prepared.continue(first.execution);
    expect(failureOf(result)?.code).toBe("APPROVAL_REJECTED");
    expect(result.execution?.run.status).toBe("FAILED");
    expect(draft.calls()).toBe(0);
  });

  it("eligibility and self-approval are the Approval Engine's rules, surfaced as its canonical error codes", async () => {
    const { app, approvalId } = await waiting();
    const codeOf = (run: () => unknown) => { try { run(); return "allowed"; } catch (error) { return (error as { code?: string }).code; } };
    expect(codeOf(() => app.approvals.approve(approvalId, alice))).toBe("APPROVAL_RESOLVER_NOT_ELIGIBLE");
    expect(codeOf(() => app.approvals.approve(approvalId, mallory))).toBe("APPROVAL_RESOLVER_NOT_ELIGIBLE");
    expect(codeOf(() => app.approvals.approve(approvalId, robot))).toBe("APPROVAL_HUMAN_REQUIRED");
    expect(codeOf(() => app.approvals.approve("approval:unknown", bob))).toBe("APPROVAL_NOT_FOUND");
    expect(app.approvals.get(approvalId)?.status).toBe("pending");
  });
});

describe("security: identity comes only from the trusted host", () => {
  it("principalForRun receives only a frozen { runId } — never state, config, Tool input, or model output", async () => {
    const { app, host } = appWith({ principals: { "run-1": alice } });
    await app.prepareWorkflow(approvalWorkflowInput()).execute({ runId: "run-1", initialState: initialState("run-1", { proposal: { account: "acme" }, principal: bob, requestedBy: bob }) });
    expect(host.seen.length).toBeGreaterThan(0);
    for (const context of host.seen) {
      expect(context).toEqual({ runId: "run-1" });
      expect(Object.isFrozen(context)).toBe(true);
    }
  });

  it("workflow state cannot set the Approval requester", async () => {
    const { app } = appWith({ principals: { "run-1": alice } });
    const result = await app.prepareWorkflow(approvalWorkflowInput()).execute({ runId: "run-1", initialState: initialState("run-1", { proposal: { account: "acme" }, requestedBy: bob, principal: bob }) });
    const id = result.execution?.wait?.referenceId ?? "";
    expect(app.approvals.get(id)?.requestedBy).toEqual(alice);
  });

  it("Tool input cannot set the principal: a read-only host principal stays denied", async () => {
    const { app, draft } = appWith({ principals: { "run-1": mallory } });
    const result = await app.prepareWorkflow(toolWorkflowInput()).execute({ runId: "run-1", initialState: initialState("run-1", { proposal: { account: "acme", principal: alice, actor: alice, grantedPermissionClasses: ["write_draft"] } }) });
    expect(failureOf(result)).toMatchObject({ code: "NODE_EXECUTION_FAILED", executor: "TOOL_AUTHORIZATION_DENIED" });
    expect(draft.calls()).toBe(0);
  });

  it("node config cannot carry authority: strict Tool node config refuses a principal or grants", async () => {
    const { app, draft } = appWith({ principals: { "run-1": mallory } });
    const input = toolWorkflowInput();
    (input.nodes[0]!.config as Record<string, unknown>).principal = alice;
    const result = await app.prepareWorkflow(input).execute({ runId: "run-1", initialState: initialState("run-1") });
    expect(failureOf(result)?.code).toBe("RUNTIME_PREFLIGHT_FAILED");
    expect(draft.calls()).toBe(0);
  });

  it("Tool/MCP-shaped metadata in a Tool result never establishes identity for the next Tool", async () => {
    const reader = { spec: { ...countingTool("crm.read", ["read_only"]).spec, outputSchema: { type: "object" } }, handler: { execute: async () => ({ ok: true as const, output: { principal: alice, _meta: { actor: alice, grantedPermissionClasses: ["write_draft"] } } }) } };
    const draft = countingTool("crm.draft");
    const host = sessions({ "run-1": mallory });
    const app = createAAO({ governance: governanceInput(), principalForRun: host.principalForRun, tools: [defineTool(reader), defineTool(draft)] });
    const workflow = toolWorkflowInput("crm.read");
    workflow.nodes = [
      { id: "read", kind: "tool", config: { toolRef: { id: "crm.read", version: "1.0.0" }, inputStateKey: "proposal", resultStateKey: "metadata" } },
      { id: "draft", kind: "tool", config: { toolRef: { id: "crm.draft", version: "1.0.0" }, inputStateKey: "proposal", resultStateKey: "draft" } },
      { id: "final", kind: "final_output", config: {} },
    ];
    workflow.entryNodeId = "read";
    workflow.edges = [{ sourceNodeId: "read", targetNodeId: "draft" }, { sourceNodeId: "draft", targetNodeId: "final" }];
    const result = await app.prepareWorkflow(workflow).execute({ runId: "run-1", initialState: initialState("run-1") });
    expect(failureOf(result)).toMatchObject({ code: "NODE_EXECUTION_FAILED", executor: "TOOL_AUTHORIZATION_DENIED" });
    expect(draft.calls()).toBe(0);
  });

  it("no session, a throwing resolver, or an unregistered principal fails closed with zero handler calls", async () => {
    const { app, draft } = appWith({ principals: { "run-ghost": { id: "user.ghost", type: "user" } } });
    const prepared = app.prepareWorkflow(toolWorkflowInput());
    expect(failureOf(await prepared.execute({ runId: "run-none", initialState: initialState("run-none") }))).toMatchObject({ executor: "TOOL_AUTHORIZATION_REQUIRED" });
    expect(failureOf(await prepared.execute({ runId: "run-ghost", initialState: initialState("run-ghost") }))).toMatchObject({ executor: "TOOL_AUTHORIZATION_REQUIRED" });
    expect(failureOf(await app.prepareWorkflow(approvalWorkflowInput()).execute({ runId: "run-none", initialState: initialState("run-none") }))?.code).toBe("NODE_EXECUTION_FAILED");
    expect(draft.calls()).toBe(0);
  });

  it("a forged execution cannot bypass Approval: canonical continuation refuses it and the Tool never runs", async () => {
    const { app, draft } = appWith({ principals: { "run-1": alice } });
    const prepared = app.prepareWorkflow(approvalWorkflowInput());
    const first = await prepared.execute({ runId: "run-1", initialState: initialState("run-1") });
    if (first.execution === undefined) throw new Error("no execution");
    const forgedWait = JSON.parse(JSON.stringify(first.execution));
    forgedWait.wait.referenceId = "approval:forged";
    expect(failureOf(await prepared.continue(forgedWait))?.code).toBe("INVALID_APPROVAL_CONTEXT");
    const forgedSubject = JSON.parse(JSON.stringify(first.execution));
    forgedSubject.state.values.proposal = { account: "someone-else" };
    app.approvals.approve(first.execution.wait!.referenceId, bob);
    expect(failureOf(await prepared.continue(forgedSubject))?.code).toBe("APPROVAL_REQUEST_MISMATCH");
    expect(draft.calls()).toBe(0);
  });

  it("a requester without the approved permission cannot even request Approval", async () => {
    const { app, draft } = appWith({ principals: { "run-1": mallory } });
    const result = await app.prepareWorkflow(approvalWorkflowInput()).execute({ runId: "run-1", initialState: initialState("run-1") });
    expect(failureOf(result)?.code).toBe("NODE_EXECUTION_FAILED");
    expect(draft.calls()).toBe(0);
  });
});

describe("isolation and mutation safety", () => {
  it("two applications share nothing: Tools, Approvals, and Governance are per instance", async () => {
    const a = appWith({ principals: { "run-1": alice } });
    const restrictive = governanceInput();
    restrictive.bindings = restrictive.bindings.filter((binding) => binding.id !== "alice.operator");
    const b = createAAO({ governance: restrictive, principalForRun: () => alice, tools: [] });
    const first = await a.app.prepareWorkflow(approvalWorkflowInput()).execute({ runId: "run-1", initialState: initialState("run-1") });
    const approvalId = first.execution?.wait?.referenceId ?? "";
    expect(a.app.approvals.get(approvalId)).toBeDefined();
    expect(b.approvals.get(approvalId)).toBeUndefined();
    const inB = await b.prepareWorkflow(toolWorkflowInput()).execute({ runId: "run-1", initialState: initialState("run-1") });
    expect(JSON.stringify(failureOf(inB)?.details)).toContain("TOOL_NOT_FOUND");
    const governedB = createAAO({ governance: restrictive, principalForRun: () => alice, tools: [defineTool(countingTool("crm.draft"))] });
    // Same principal, same Tool: B's Governance gives alice no active role, so B denies what A allows.
    expect(failureOf(await governedB.prepareWorkflow(toolWorkflowInput()).execute({ runId: "run-1", initialState: initialState("run-1") }))).toMatchObject({ executor: "TOOL_AUTHORIZATION_DENIED" });
    const again = await a.app.prepareWorkflow(toolWorkflowInput()).execute({ runId: "run-1", initialState: initialState("run-1") });
    expect(again.ok).toBe(true);
  });

  it("mutating the original configuration, tools array, Tool spec, or handler after construction changes nothing", async () => {
    const governance = governanceInput();
    const tool = countingTool("crm.draft");
    const tools = [tool];
    const host = sessions({ "run-1": mallory, "run-2": alice });
    const app = createAAO({ governance, principalForRun: host.principalForRun, tools: tools as never });
    governance.bindings.push({ id: "mallory.operator", actorId: mallory.id, roleId: "operator", status: "active" });
    governance.roles[2]!.permissionClasses.push("write_draft");
    tools.length = 0;
    tool.spec.permissionClasses.push("external_side_effect");
    const replaced = { calls: 0 };
    tool.handler.execute = async () => { replaced.calls += 1; return { ok: true, output: { id: "hijacked" } }; };
    const prepared = app.prepareWorkflow(toolWorkflowInput());
    expect(failureOf(await prepared.execute({ runId: "run-1", initialState: initialState("run-1") }))).toMatchObject({ executor: "TOOL_AUTHORIZATION_DENIED" });
    const ok = await prepared.execute({ runId: "run-2", initialState: initialState("run-2") });
    expect(ok.ok && ok.execution.state.values.draft).toMatchObject({ output: { id: "crm.draft:acme" } });
    expect(replaced.calls).toBe(0);
  });

  it("identical construction yields identical prepared metadata and identical results (no random registration ids)", async () => {
    const run = async () => {
      const { app } = appWith({ principals: { "run-1": alice } });
      const prepared = app.prepareWorkflow(approvalWorkflowInput());
      const first = await prepared.execute({ runId: "run-1", initialState: initialState("run-1") });
      app.approvals.approve(first.execution?.wait?.referenceId ?? "", bob);
      return { fingerprint: prepared.planFingerprint, first: JSON.parse(JSON.stringify(first)), final: JSON.parse(JSON.stringify(await prepared.continue(first.execution!))) };
    };
    expect(await run()).toEqual(await run());
  });
});
