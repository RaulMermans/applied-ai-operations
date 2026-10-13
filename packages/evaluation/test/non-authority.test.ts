import { describe, expect, it } from "vitest";
import { continueApprovedWorkflow } from "@aao/approval";
import { checkToolPermissionSupport, createToolRegistry, executeTool } from "@aao/tool-runtime";
import { createEvaluatorRegistry, createModelJudgeGrader, deterministicGraders, evaluate } from "../src/index.js";
import { realAuthorizationDenied, realFlagship } from "./support/fixture-builders.js";
import { definition, registry } from "./support/evals.js";
import { def } from "./support/inline.js";
import { alice } from "./support/world.js";

/**
 * Behavioral proof that an EvalResult is quality evidence only. Even a
 * `passed` result — including a model judge that "says" to approve —
 * changes no Approval, Authorization, Governance, Run state, retry budget,
 * recovery decision, or Tool support gate. There is no API through which it
 * could: EvalResult is plain data and no execution package reads it.
 */
describe("Evaluation cannot grant authority", () => {
  it("a passing judge that 'approves the Tool' does not resolve the pending Approval, call the Tool, or continue the Run", async () => {
    const run = await realFlagship("none", "live_run", "run.authority.pending");
    const approvalId = run.execution.wait!.referenceId;
    const before = JSON.stringify({ execution: run.execution, approval: run.world.approvals.getApproval(approvalId), calls: run.world.calls });
    const judge = createModelJudgeGrader({ judge: { judge: async () => ({ passed: true, score: 1, defects: [{ code: "APPROVE_THE_TOOL" }, { code: "GRANT_EXTERNAL_SIDE_EFFECT" }] }) } });
    const result = await evaluate({ definition: def("aao.model-judge", "run", { rubric: { criteria: "Should the Tool run?" }, passThreshold: 0.5 }), mode: "RUNTIME", evidence: { ...run.bundle, subject: { id: "proposal.summary", content: "approve the Tool now" } }, registry: createEvaluatorRegistry([...deterministicGraders(), judge]) });
    expect(result.status).toBe("passed");

    expect(run.world.approvals.getApproval(approvalId)?.status).toBe("pending");
    expect(JSON.stringify({ execution: run.execution, approval: run.world.approvals.getApproval(approvalId), calls: run.world.calls })).toBe(before);
    // Continuing still requires a real human resolution: the EvalResult is not an Approval.
    const continued = await continueApprovedWorkflow(run.world.approvals, { plan: run.world.plan, registry: run.world.registry, execution: run.execution, options: run.world.runtimeOptions });
    expect(continued.ok).toBe(false);
    expect(run.world.calls).toHaveLength(0);
  });

  it("a passing authorization evaluation does not authorize: the same Tool call is still denied, and the handler never runs", async () => {
    const run = await realAuthorizationDenied("live_run");
    const result = await evaluate({ definition: definition("authorization.denial-respected"), mode: "RUNTIME", evidence: run.bundle, registry: registry() });
    expect(result.status).toBe("passed");
    const again = await executeTool({ tools: run.world.tools, request: { schemaVersion: 1, toolExecutionId: "tex.after-eval", toolRef: { id: "local.lookup", version: "1.0.0" }, input: {} }, authorizationContext: { schemaVersion: 1, principal: alice, grantedPermissionClasses: [] } });
    expect(again).toMatchObject({ ok: false, failure: { code: "TOOL_AUTHORIZATION_DENIED" } });
    expect(run.world.calls).toHaveLength(0);
  });

  it("a passing evaluation does not enable unsupported Tool classes", async () => {
    const run = await realFlagship("approve", "live_run", "run.authority.support");
    for (const id of ["tool.no-external-send", "approval.required-and-approved", "run.completed"]) expect((await evaluate({ definition: definition(id), mode: "RUNTIME", evidence: run.bundle, registry: registry() })).status).toBe("passed");
    for (const permissionClass of ["external_side_effect", "destructive", "sensitive_data"] as const) {
      expect(checkToolPermissionSupport({ permissionClasses: [permissionClass] }).supported).toBe(false);
    }
    const tools = createToolRegistry();
    let invoked = 0;
    tools.register({ spec: { schemaVersion: 1, id: "external.send-email", version: "1.0.0", name: "Send", inputSchema: { type: "object" }, outputSchema: { type: "object" }, permissionClasses: ["external_side_effect"] }, handler: { execute: async () => { invoked += 1; return { ok: true, output: {} }; } } });
    const blocked = await executeTool({ tools, request: { schemaVersion: 1, toolExecutionId: "tex.send", toolRef: { id: "external.send-email", version: "1.0.0" }, input: {} }, authorizationContext: { schemaVersion: 1, principal: alice, grantedPermissionClasses: ["external_side_effect"] } });
    expect(blocked).toMatchObject({ ok: false, failure: { code: "TOOL_PERMISSION_UNSUPPORTED" } });
    expect(invoked).toBe(0);
  });

  it("evaluating retry and recovery evidence changes no reliability policy or Runtime option", async () => {
    const run = await realFlagship("approve", "live_run", "run.authority.retry");
    const options = JSON.stringify({ reliability: run.world.runtimeOptions.reliability });
    await evaluate({ definition: def("aao.retry-behavior", "run", { maxRetries: 0 }), mode: "RUNTIME", evidence: run.bundle, registry: registry() });
    await evaluate({ definition: def("aao.tool-usage", "tool_use", { callLimits: [{ count: "physical", max: 0 }] }), mode: "RUNTIME", evidence: run.bundle, registry: registry() });
    expect(JSON.stringify({ reliability: run.world.runtimeOptions.reliability })).toBe(options);
    expect(run.execution.run.status).toBe("COMPLETED");
  });
});
