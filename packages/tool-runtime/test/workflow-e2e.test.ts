import { describe, expect, it } from "vitest";
import type { PermissionClass } from "@aao/contracts";
import { compileWorkflowSource } from "@aao/workflow-dsl";
import { RuntimeExecutionSnapshotSchema, createNodeRegistry, executeWorkflow, finalOutputExecutor, validateSnapshotAgainstPlan, type NodeExecutor } from "@aao/runtime";
import { deriveToolExecutionId } from "../src/execution-id.js";
import { createToolNodeExecutor } from "../src/tool-node.js";
import { ToolResultSchema, type ToolHandlerResult } from "../src/types.js";
import { LOOKUP_REF, SECRET, lookupWorld } from "./fixtures.js";

/**
 * Real production path, no network, no credentials, no mocked plans:
 * YAML → Workflow Compiler → managed Runtime → Tool Node → Tool Runtime →
 * Tool Registry → deterministic in-memory handler → output validation →
 * state patch → final_output.
 */
const WORKFLOW_YAML = `
schemaVersion: 1
id: examples.local-lookup
version: "1.0.0"
name: Local lookup tool
entryNodeId: lookup
nodes:
  - id: lookup
    kind: tool
    config:
      toolRef:
        id: local.lookup
        version: "1.0.0"
      inputStateKey: lookupInput
      resultStateKey: lookupResult
  - id: final
    kind: final_output
    config: {}
edges:
  - sourceNodeId: lookup
    targetNodeId: final
`;

function compile() {
  const compiled = compileWorkflowSource(WORKFLOW_YAML, "yaml");
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  return compiled.plan;
}

function testClock() {
  let calls = 0;
  return { now: () => new Date(Date.UTC(2026, 8, 25, 14, 0, calls++)).toISOString() };
}

function run(runId: string, options: { input?: unknown; permissionClasses?: PermissionClass[]; respond?: (input: unknown) => ToolHandlerResult } = {}) {
  const plan = compile();
  const world = lookupWorld({
    ...(options.permissionClasses !== undefined ? { spec: { permissionClasses: options.permissionClasses } } : {}),
    ...(options.respond !== undefined ? { respond: (context) => options.respond!(context.input) } : {}),
  });
  // A spy that counts *every* workflow node execution, independent of Tool handler counting.
  const nodeExecutions: string[] = [];
  const toolNode = createToolNodeExecutor({ tools: world.tools });
  const spiedToolNode: NodeExecutor = {
    ...toolNode,
    async execute(context) {
      nodeExecutions.push(context.node.id);
      return toolNode.execute(context);
    },
  };
  const registry = createNodeRegistry();
  registry.register(spiedToolNode);
  registry.register({
    ...finalOutputExecutor,
    async execute(context) {
      nodeExecutions.push(context.node.id);
      return finalOutputExecutor.execute(context);
    },
  });
  const initialState = { runId, revision: 0, values: { lookupInput: (options.input ?? { query: "alpha" }) as never } };
  return { plan, handler: world.handler, nodeExecutions, initialState, result: executeWorkflow({ runId, plan, initialState, registry, options: { clock: testClock() } }) };
}

describe("Tool workflow E2E: YAML → compiler → Runtime → Tool Node → Tool Runtime → handler", () => {
  it("success: validated input → one handler call → validated output → one state patch → final_output → COMPLETED", async () => {
    const { plan, handler, nodeExecutions, result: pending } = run("run.tool.ok");
    const result = await pending;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(handler.calls).toEqual([{ toolExecutionId: deriveToolExecutionId("run.tool.ok", "lookup"), tool: { ...LOOKUP_REF }, input: { query: "alpha" } }]);
    expect(nodeExecutions).toEqual(["lookup", "final"]);
    expect(result.execution.run.status).toBe("COMPLETED");
    expect(result.execution.nodeStatusesById).toEqual({ lookup: "SUCCEEDED", final: "SUCCEEDED" });
    expect(result.execution.step).toBe(2);
    expect(result.execution.state.revision).toBe(1);
    const toolResult = ToolResultSchema.parse(result.execution.state.values.lookupResult);
    expect(toolResult).toEqual({ schemaVersion: 1, toolExecutionId: deriveToolExecutionId("run.tool.ok", "lookup"), toolRef: { ...LOOKUP_REF }, output: { items: ["alpha-result"] } });
    expect(result.output).toEqual({ lookupInput: { query: "alpha" }, lookupResult: toolResult });
    expect(result.execution.history.map((record) => [record.nodeId, record.status, record.stateRevisionBefore, record.stateRevisionAfter])).toEqual([
      ["lookup", "SUCCEEDED", 0, 1],
      ["final", "SUCCEEDED", 1, 1],
    ]);
    expect(validateSnapshotAgainstPlan(result.latestSnapshot, plan)).toBeUndefined();
    expect(RuntimeExecutionSnapshotSchema.parse(JSON.parse(JSON.stringify(result.latestSnapshot)))).toEqual(result.latestSnapshot);
  });

  it("input-schema failure: zero handler calls, TOOL_INPUT_SCHEMA_MISMATCH, Run FAILED, final PENDING, state unchanged", async () => {
    const { plan, handler, initialState, result: pending } = run("run.tool.bad-input", { input: { query: 42 } });
    const result = await pending;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(handler.calls).toHaveLength(0);
    expect(result.failure).toEqual({
      code: "NODE_EXECUTION_FAILED",
      message: 'Node "lookup" (kind "tool") reported an executor failure.',
      nodeId: "lookup",
      step: 1,
      executorFailure: { namespace: "tool", code: "TOOL_INPUT_SCHEMA_MISMATCH" },
    });
    expect(result.execution?.run.status).toBe("FAILED");
    expect(result.execution?.nodeStatusesById).toEqual({ lookup: "FAILED", final: "PENDING" });
    expect(result.execution?.state).toEqual(initialState);
    expect(result.latestSnapshot?.stateSnapshot).toMatchObject({ revision: 0, values: { lookupInput: { query: 42 } } });
    expect(validateSnapshotAgainstPlan(result.latestSnapshot, plan)).toBeUndefined();
  });

  it("output-schema failure: one handler call, TOOL_OUTPUT_SCHEMA_MISMATCH, no state patch, malformed output never enters RunState", async () => {
    const { plan, handler, initialState, result: pending } = run("run.tool.bad-output", { respond: () => ({ ok: true, output: { items: "MALFORMED-OUTPUT" } }) });
    const result = await pending;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(handler.calls).toHaveLength(1);
    expect(result.failure).toMatchObject({ code: "NODE_EXECUTION_FAILED", nodeId: "lookup", executorFailure: { namespace: "tool", code: "TOOL_OUTPUT_SCHEMA_MISMATCH" } });
    expect(result.execution?.run.status).toBe("FAILED");
    expect(result.execution?.nodeStatusesById).toEqual({ lookup: "FAILED", final: "PENDING" });
    expect(result.execution?.state).toEqual(initialState);
    expect(result.execution?.history).toEqual([{ nodeId: "lookup", kind: "tool", step: 1, status: "FAILED", stateRevisionBefore: 0, stateRevisionAfter: 0 }]);
    expect(validateSnapshotAgainstPlan(result.latestSnapshot, plan)).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("MALFORMED-OUTPUT");
  });

  it("explicit safe handler failure: TOOL_EXECUTION_FAILED at the Runtime; one call; no partial state", async () => {
    const { plan, handler, initialState, result: pending } = run("run.tool.handler-fail", { respond: () => ({ ok: false, code: "NOT_FOUND" }) });
    const result = await pending;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(handler.calls).toHaveLength(1);
    // The generic Runtime carries only { namespace, code }: it never learns Tool handler semantics.
    expect(result.failure.executorFailure).toEqual({ namespace: "tool", code: "TOOL_EXECUTION_FAILED" });
    expect(result.execution?.nodeStatusesById).toEqual({ lookup: "FAILED", final: "PENDING" });
    expect(result.execution?.state).toEqual(initialState);
    expect(validateSnapshotAgainstPlan(result.latestSnapshot, plan)).toBeUndefined();
  });

  it("thrown handler: generic TOOL_EXECUTION_FAILED; no message, stack, or secret anywhere; one call, no retry", async () => {
    const { plan, handler, initialState, result: pending } = run("run.tool.throw", {
      respond: () => {
        throw new Error(SECRET);
      },
    });
    const result = await pending;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(handler.calls).toHaveLength(1);
    expect(result.failure).toEqual({
      code: "NODE_EXECUTION_FAILED",
      message: 'Node "lookup" (kind "tool") reported an executor failure.',
      nodeId: "lookup",
      step: 1,
      executorFailure: { namespace: "tool", code: "TOOL_EXECUTION_FAILED" },
    });
    expect(result.execution?.state).toEqual(initialState);
    expect(JSON.stringify(result)).not.toMatch(/secret|token|internal\.example|stack|Error/i);
    expect(validateSnapshotAgainstPlan(result.latestSnapshot, plan)).toBeUndefined();
  });

  it.each<[PermissionClass[]]>([[["external_side_effect"]], [["sensitive_data"]], [["read_only", "sensitive_data"]], [["destructive"]]])(
    "permission block (%j): RUNTIME_PREFLIGHT_FAILED, zero workflow nodes executed, zero handler calls",
    async (permissionClasses) => {
      const { handler, nodeExecutions, initialState, result: pending } = run("run.tool.blocked", { permissionClasses });
      const result = await pending;

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure).toMatchObject({ code: "RUNTIME_PREFLIGHT_FAILED", nodeId: "lookup" });
      expect(nodeExecutions).toEqual([]);
      expect(handler.calls).toEqual([]);
      expect(result.execution?.run.status).toBe("FAILED");
      expect(result.execution?.nodeStatusesById).toEqual({ lookup: "PENDING", final: "PENDING" });
      expect(result.execution?.state).toEqual(initialState);
    },
  );
});
