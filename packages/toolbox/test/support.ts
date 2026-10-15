import { createAAO, defineGovernance, defineTool, type AAOApp, type JsonValue, type Principal, type ReliabilityPolicy, type ToolDefinition, type Workflow, type WorkflowExecutionResult } from "@aao/framework";
import { createInMemoryTraceStore, createTraceRecorder } from "@aao/observability";
import type { ToolSpec, TraceEvent } from "@aao/contracts";
import { createToolRegistry, executeTool } from "@aao/tool-runtime";
import { coreToolbox, selectToolboxTools, type ToolboxToolRef } from "../src/index.js";

export const SECRET = "SECRET_DO_NOT_PERSIST";

export const alice: Principal = { id: "user.alice", type: "user" }; // analyst: read_only
export const drafter: Principal = { id: "user.drafter", type: "user" }; // write_draft only: lacks read_only

export const governance = defineGovernance({
  actors: [alice, drafter],
  roles: [
    { id: "analyst", version: "1.0.0", permissionClasses: ["read_only"] },
    { id: "drafter", version: "1.0.0", permissionClasses: ["write_draft"] },
  ],
  bindings: [
    { id: "alice.analyst", actorId: alice.id, roleId: "analyst", status: "active" },
    { id: "drafter.drafter", actorId: drafter.id, roleId: "drafter", status: "active" },
  ],
  policies: [],
});

export const ref = (id: string): ToolboxToolRef => ({ id, version: "1.0.0" });
export const CORE_IDS = ["text.normalize", "text.chunk", "records.dedupe", "records.project", "records.sort", "records.count_by"] as const;

export function fixedClock() {
  let tick = 0;
  return { now: () => new Date(Date.UTC(2026, 9, 15, 8, 0, tick++)).toISOString() };
}

/** A Workflow that runs one Tool node on `values.input` and stores the canonical ToolResult at `values.result`. */
export function singleToolWorkflow(toolRef: ToolboxToolRef, id = `toolbox.single.${toolRef.id.replace(/[._]/g, "-")}`): Workflow {
  return {
    schemaVersion: 1,
    id,
    version: "1.0.0",
    name: `Run ${toolRef.id}`,
    entryNodeId: "run",
    nodes: [
      { id: "run", kind: "tool", config: { toolRef, inputStateKey: "input", resultStateKey: "result" } },
      { id: "final", kind: "final_output", config: {} },
    ],
    edges: [{ sourceNodeId: "run", targetNodeId: "final" }],
  };
}

/** Wraps a definition with a call counter while keeping its spec and trusted registration metadata. */
export function counted(tool: ToolDefinition): { tool: ToolDefinition; calls: () => number } {
  let calls = 0;
  const wrapped = defineTool({
    spec: tool.spec,
    handler: { execute: (context) => { calls += 1; return tool.handler.execute(context); } },
    ...(tool.retrySafety !== undefined ? { retrySafety: tool.retrySafety } : {}),
    ...(tool.idempotency !== undefined ? { idempotency: tool.idempotency } : {}),
  });
  return { tool: wrapped, calls: () => calls };
}

export interface RunOutcome {
  result: WorkflowExecutionResult;
  trace: TraceEvent[];
  output: JsonValue | undefined;
}

/** Runs a Workflow on a fresh app with a Trace recorder: the normal Framework → Tool Registry → Tool Runtime path. */
export async function run(options: {
  tools: readonly ToolDefinition[];
  workflow: Workflow;
  values: Record<string, JsonValue>;
  principal?: Principal;
  runId?: string;
  reliability?: Record<string, ReliabilityPolicy>;
  deterministicExecutors?: Parameters<typeof createAAO>[0]["deterministicExecutors"];
}): Promise<RunOutcome> {
  const clock = fixedClock();
  const store = createInMemoryTraceStore();
  const runId = options.runId ?? "run.toolbox";
  const app: AAOApp = createAAO({
    governance,
    principalForRun: () => options.principal ?? alice,
    tools: options.tools,
    trace: createTraceRecorder({ store, clock }),
    clock,
    ...(options.deterministicExecutors ? { deterministicExecutors: options.deterministicExecutors } : {}),
  });
  const prepared = app.prepareWorkflow(options.workflow, options.reliability ? { reliability: { policiesByNodeId: options.reliability } } : undefined);
  const result = await prepared.execute({ runId, initialState: { runId, revision: 0, values: options.values } });
  const trace = (await store.getRunTrace(runId)) as TraceEvent[];
  const stored = result.execution?.state.values.result as { output?: JsonValue } | undefined;
  return { result, trace, output: stored?.output };
}

/** Runs one Core Toolbox Tool on `input` through createAAO. */
export function runCoreTool(id: string, input: JsonValue, options: { principal?: Principal; runId?: string } = {}): Promise<RunOutcome> {
  return run({ tools: selectToolboxTools(coreToolbox, [ref(id)]), workflow: singleToolWorkflow(ref(id)), values: { input }, ...options });
}

export const eventsOf = (trace: readonly TraceEvent[], type: string) => trace.filter((event) => event.type === type);

/**
 * Executes one Core Tool through the canonical `executeTool` path (registry →
 * support gate → Authorization → input schema → handler → output schema)
 * with a read_only grant: the Tool Runtime boundary without a Workflow.
 */
export async function execute(id: string, input: unknown) {
  const registry = createToolRegistry();
  for (const tool of selectToolboxTools(coreToolbox, [ref(id)])) registry.register({ spec: { ...tool.spec, permissionClasses: [...tool.spec.permissionClasses] } as ToolSpec, handler: tool.handler, retrySafety: tool.retrySafety! });
  return executeTool({ tools: registry, request: { schemaVersion: 1, toolExecutionId: "unit.exec", toolRef: ref(id), input }, authorizationContext: { schemaVersion: 1, principal: alice, grantedPermissionClasses: ["read_only"] } });
}

/** The successful output of `execute`, or a thrown assertion with the failure. */
export async function output<T = Record<string, unknown>>(id: string, input: unknown): Promise<T> {
  const result = await execute(id, input);
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.failure)}`);
  return result.result.output as T;
}

/** Calls a Core Tool's handler directly (unit level). Production calls go through executeTool, which validates input first. */
export async function callHandler(id: string, input: JsonValue) {
  const [tool] = selectToolboxTools(coreToolbox, [ref(id)]);
  return tool!.handler.execute({ toolExecutionId: "unit.call", tool: ref(id), input });
}
