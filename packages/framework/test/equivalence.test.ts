import { describe, expect, it } from "vitest";
import { createApprovalEngine, createApprovalNodeExecutor, continueApprovedWorkflow } from "@aao/approval";
import { authorizationContextFromAuthority } from "@aao/authorization";
import type { Principal, RunState, Workflow } from "@aao/contracts";
import { createGovernanceRegistry, resolveAuthority } from "@aao/governance";
import { createNodeRegistry, executeWorkflow, finalOutputExecutor, type RuntimeExecutionState, type WorkflowExecutionResult } from "@aao/runtime";
import { createToolNodeExecutor, createToolRegistry } from "@aao/tool-runtime";
import { compileWorkflow } from "@aao/workflow-dsl";
import { createAAO, defineTool } from "../src/index.js";
import { alice, approvalWorkflowInput, bob, countingTool, governanceInput, initialState, mallory, testClock, toolWorkflowInput } from "./support.js";

/** The common surface both paths expose to a scenario. */
interface Path {
  execute(runId: string, state: RunState): Promise<WorkflowExecutionResult>;
  continue(execution: RuntimeExecutionState): Promise<WorkflowExecutionResult>;
  approve(id: string, principal: Principal): unknown;
  reject(id: string, principal: Principal): unknown;
  calls(): number;
}

type ToolFactory = () => ReturnType<typeof countingTool>;

/** Path A: the existing lower-level packages composed by hand, as a host did before Sprint 19. */
function manualPath(workflow: Workflow, principal: Principal, makeTool: ToolFactory): Path {
  const tool = makeTool();
  const clock = testClock();
  const governance = createGovernanceRegistry(governanceInput());
  const tools = createToolRegistry();
  tools.register({ spec: tool.spec, handler: tool.handler });
  const approvals = createApprovalEngine({ governance, clock });
  const registry = createNodeRegistry();
  registry.register(
    createToolNodeExecutor({
      tools,
      resolveAuthorizationContext: (target) => {
        const spec = tools.getSpec(target.toolRef);
        const authority = spec === undefined ? undefined : resolveAuthority(governance, principal, spec.permissionClasses).authority;
        return authority === undefined ? undefined : authorizationContextFromAuthority(authority);
      },
    }),
  );
  registry.register(createApprovalNodeExecutor(approvals, () => principal));
  registry.register(finalOutputExecutor);
  const compiled = compileWorkflow(workflow);
  if (!compiled.ok) throw new Error("compile");
  return {
    execute: (runId, state) => executeWorkflow({ runId, plan: compiled.plan, registry, initialState: state, options: { clock } }),
    continue: (execution) => continueApprovedWorkflow(approvals, { plan: compiled.plan, registry, execution, options: { clock } }),
    approve: (id, by) => approvals.approve(id, by),
    reject: (id, by) => approvals.reject(id, by),
    calls: tool.calls,
  };
}

/** Path B: the public framework. */
function frameworkPath(workflow: Workflow, principal: Principal, makeTool: ToolFactory): Path {
  const tool = makeTool();
  const app = createAAO({ governance: governanceInput(), principalForRun: () => principal, tools: [defineTool(tool)], clock: testClock() });
  const prepared = app.prepareWorkflow(workflow);
  return {
    execute: (runId, state) => prepared.execute({ runId, initialState: state }),
    continue: (execution) => prepared.continue(execution),
    approve: (id, by) => app.approvals.approve(id, by),
    reject: (id, by) => app.approvals.reject(id, by),
    calls: tool.calls,
  };
}

const snapshot = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

/** Runs one scenario and records everything observable: results (status, revision, values, node statuses, history, failures, snapshots), Approval records, and handler calls. */
async function scenario(path: Path, decision: "approve" | "reject" | "none") {
  const first = await path.execute("run-eq", initialState("run-eq"));
  const trace: unknown[] = [snapshot(first), path.calls()];
  const wait = first.execution?.wait;
  if (decision !== "none" && wait && first.execution) {
    trace.push(snapshot(await path.continue(snapshot(first.execution) as RuntimeExecutionState)));
    trace.push(snapshot(decision === "approve" ? path.approve(wait.referenceId, bob) : path.reject(wait.referenceId, bob)));
    trace.push(snapshot(await path.continue(first.execution)), path.calls());
  }
  return trace;
}

const draft: ToolFactory = () => countingTool("crm.draft");
const cases: Array<[string, Workflow, Principal, ToolFactory, "approve" | "reject" | "none"]> = [
  ["Approval approved → Tool → final", approvalWorkflowInput(), alice, draft, "approve"],
  ["Approval rejected", approvalWorkflowInput(), alice, draft, "reject"],
  ["Tool → final", toolWorkflowInput(), alice, draft, "none"],
  ["Authorization denied", toolWorkflowInput(), mallory, draft, "none"],
  ["unauthorized Approval requester", approvalWorkflowInput(), mallory, draft, "approve"],
  ["unsupported permission class", toolWorkflowInput("mail.send"), alice, () => countingTool("mail.send", ["external_side_effect"]), "none"],
  ["handler failure", toolWorkflowInput(), alice, () => countingTool("crm.draft", ["write_draft"], () => ({ ok: false, code: "UPSTREAM_DOWN" })), "none"],
];

describe("Framework ≡ lower-level composition: convenience, not different semantics", () => {
  it.each(cases)("%s: identical results, state, history, failures, Approval records, and Tool calls", async (_name, workflow, principal, makeTool, decision) => {
    const manual = await scenario(manualPath(workflow, principal, makeTool), decision);
    const framework = await scenario(frameworkPath(workflow, principal, makeTool), decision);
    expect(framework).toEqual(manual);
  });

  it("the comparison is meaningful: the approved scenario really waited, continued, and called the Tool once", async () => {
    const trace = await scenario(frameworkPath(approvalWorkflowInput(), alice, draft), "approve");
    expect(trace[0]).toMatchObject({ ok: true, execution: { run: { status: "WAITING_FOR_APPROVAL" } } });
    expect(trace[2]).toMatchObject({ ok: false, failure: { code: "APPROVAL_STILL_PENDING" } });
    expect(trace[4]).toMatchObject({ ok: true, execution: { run: { status: "COMPLETED" }, state: { revision: 1 } } });
    expect(trace.at(-1)).toBe(1);
  });
});
