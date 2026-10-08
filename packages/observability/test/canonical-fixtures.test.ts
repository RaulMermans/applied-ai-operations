import { describe, expect, it } from "vitest";
import { continueApprovedWorkflow } from "@aao/approval";
import { TraceEventSchema, type TraceEvent } from "@aao/contracts";
import { executeWorkflow } from "@aao/runtime";
import { createDurableRuntimeHost, createFileDurabilityStore, DurabilityError } from "@aao/durability";
import { createApprovalEngine, createApprovalNodeExecutor } from "@aao/approval";
import { createNodeRegistry, finalOutputExecutor } from "@aao/runtime";
import { createToolNodeExecutor, createToolRegistry } from "@aao/tool-runtime";
import { createFileTraceStore, createTraceRecorder, validateTrace } from "../src/index.js";
import { SECRET, TRANSIENT, alice, bob, clockAt, compile, flagshipYaml, governance, tempRoot, toolYaml, world, type WorldOptions } from "./fixtures.js";

/**
 * Representative canonical traces, committed under test/fixtures/traces/ and
 * regenerated deterministically on every run. Sanitized by construction
 * (metadata only). Future Eval Runtime, Control Center, and trace-contract
 * regressions can load them directly.
 */

async function flagship(options: WorldOptions, resolution: "approve" | "reject" | "none") {
  const w = world(options);
  const runId = "run.fixture";
  const waiting = await executeWorkflow({ runId, plan: w.plan, registry: w.registry, initialState: { runId, revision: 0, values: {} }, options: w.runtimeOptions });
  if (resolution !== "none" && waiting.ok && waiting.execution.wait) {
    if (resolution === "approve") w.approvals.approve(waiting.execution.wait.referenceId, bob);
    else w.approvals.reject(waiting.execution.wait.referenceId, bob);
    await continueApprovedWorkflow(w.approvals, { plan: w.plan, registry: w.registry, execution: waiting.execution, options: w.runtimeOptions });
  }
  return w.store.getRunTrace(runId);
}

async function tool(options: WorldOptions) {
  const w = world({ plan: compile(toolYaml), ...options });
  const runId = "run.fixture";
  await executeWorkflow({ runId, plan: w.plan, registry: w.registry, initialState: { runId, revision: 0, values: { proposal: { q: "x" } } }, options: w.runtimeOptions });
  return w.store.getRunTrace(runId);
}

/** Process A to the wait; Process B crashes after the Tool's outcome is durable but before the checkpoint; Process C recovers. */
async function durableRecovery(): Promise<TraceEvent[]> {
  const durabilityRoot = tempRoot();
  const traceRoot = tempRoot();
  const plan = compile(flagshipYaml);
  const runId = "run.fixture";
  const build = (start: number, crashCheckpoint: boolean) => {
    const base = createFileDurabilityStore({ root: durabilityRoot });
    let crashed = false;
    const store = crashCheckpoint ? { ...base, approvals: base.approvals, writeCheckpoint: (checkpoint: Parameters<typeof base.writeCheckpoint>[0]) => (!crashed && checkpoint.executionSnapshot.nodeStatusesById.lookup === "SUCCEEDED" ? ((crashed = true), Promise.reject(new DurabilityError("DURABILITY_IO_FAILED"))) : base.writeCheckpoint(checkpoint)) } : base;
    const approvals = createApprovalEngine({ governance: governance(), clock: clockAt(start), repository: store.approvals });
    const tools = createToolRegistry();
    tools.register({ spec: { schemaVersion: 1, id: "local.lookup", version: "1.0.0", name: "Lookup", inputSchema: { type: "object" }, outputSchema: { type: "object" }, permissionClasses: ["read_only"] }, handler: { execute: async () => ({ ok: true, output: { secret: SECRET } }) } });
    const registry = createNodeRegistry();
    registry.register({ kind: "deterministic", recoverySafety: () => "safe", execute: async () => ({ ok: true, statePatch: { proposal: { q: "x" } } }) });
    registry.register(createApprovalNodeExecutor(approvals, () => alice));
    registry.register(createToolNodeExecutor({ tools, resolveAuthorizationContext: () => ({ schemaVersion: 1, principal: alice, grantedPermissionClasses: ["read_only"] }) }));
    registry.register(finalOutputExecutor);
    const recorder = createTraceRecorder({ store: createFileTraceStore({ root: traceRoot }), clock: clockAt(start) });
    return { host: createDurableRuntimeHost({ store, plan, registry, approvals, clock: clockAt(start), trace: recorder }), approvals };
  };
  const a = build(0, false);
  const waiting = await a.host.execute({ runId, initialState: { runId, revision: 0, values: {} } });
  a.approvals.approve(waiting.execution!.wait!.referenceId, bob);
  await build(100, true).host.resume(runId);
  await build(200, false).host.resume(runId);
  return createFileTraceStore({ root: traceRoot }).getRunTrace(runId);
}

const retry = { toolScript: [TRANSIENT], toolRetrySafety: "safe" as const, reliability: { policiesByNodeId: { lookup: { maxAttempts: 3 } } } };
const scenarios: Array<[string, () => Promise<TraceEvent[]>, "COMPLETED" | "FAILED" | "WAITING_FOR_APPROVAL"]> = [
  ["successful_run", () => tool({}), "COMPLETED"],
  ["retry_then_success", () => tool({ ...retry, reliability: { policiesByNodeId: { lookup: { maxAttempts: 3 } } } }), "COMPLETED"],
  ["approval_wait_then_resume", () => flagship({}, "approve"), "COMPLETED"],
  ["authorization_block", () => tool({ grants: [] }), "FAILED"],
  ["durable_recovery", durableRecovery, "COMPLETED"],
  ["failed_run", () => flagship({}, "reject"), "FAILED"],
];

describe("canonical trace fixtures", () => {
  it.each(scenarios)("%s is deterministic, valid, sanitized, round-trip safe, and matches its committed fixture", async (name, build, runStatus) => {
    const events = await build();
    expect(await build()).toEqual(events);
    expect(validateTrace(events, { runStatus })).toEqual({ valid: true, issues: [] });
    expect(JSON.stringify(events)).not.toContain(SECRET);
    for (const event of events) expect(TraceEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
    await expect(`${JSON.stringify(events, null, 2)}\n`).toMatchFileSnapshot(`./fixtures/traces/${name}.json`);
  });
});
