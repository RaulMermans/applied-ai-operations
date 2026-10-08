import { describe, expect, it } from "vitest";
import type { PermissionClass } from "@aao/contracts";
import { createToolRegistry, deriveToolExecutionId } from "@aao/tool-runtime";
import { createFileDurabilityStore } from "../src/index.js";
import { clockAt, createEffects, crashingStore, initial, tempRoot, toolYaml, world } from "./fixtures.js";

const runId = "run.tool";
/** Crash after the Tool handler ran but before its accepted outcome is durable (window B). */
const crashAfterTool = (_runId: string, operationId: string) => operationId === "op.s1.a1";

describe("Tool idempotency across crash recovery", () => {
  it("idempotent write_draft: replay with the same toolExecutionId → 2 physical calls, 1 logical draft, 1 execution id", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const options = { yaml: toolYaml, root, effects, toolPermission: "write_draft" as const, toolIdempotency: "execution_id" as const };
    const first = await world({ ...options, clock: clockAt(0), store: crashingStore(createFileDurabilityStore({ root }), "recordOperationOutcome", crashAfterTool) }).host.execute({ runId, initialState: initial(runId, { request: { title: "Q3" } }) });
    expect(!first.ok && first.failure.code).toBe("DURABILITY_PERSISTENCE_FAILED");
    expect(effects.toolCalls).toBe(1);

    const resumed = await world({ ...options, clock: clockAt(1000) }).host.resume(runId);
    expect(resumed.ok && resumed.execution.run.status).toBe("COMPLETED");
    expect(effects.toolCalls).toBe(2);
    expect(effects.logicalDrafts.size).toBe(1);
    expect(new Set(effects.toolExecutionIds)).toEqual(new Set([deriveToolExecutionId(runId, "work")]));
    if (!resumed.ok) return;
    expect(resumed.execution.state.revision).toBe(1);
    expect(resumed.execution.state.values.workResult).toMatchObject({ toolExecutionId: deriveToolExecutionId(runId, "work"), output: { draftNumber: 1 } });
    const operation = (await createFileDurabilityStore({ root }).getOperationsForRun(runId))[0];
    expect(operation).toMatchObject({ attempt: 1, recoveryReplayCount: 1, status: "OUTCOME_RECORDED" });
  });

  it("non-idempotent write_draft: the ambiguous operation fails closed with DURABILITY_UNSAFE_REPLAY and zero replay calls", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const options = { yaml: toolYaml, root, effects, toolPermission: "write_draft" as const };
    await world({ ...options, clock: clockAt(0), store: crashingStore(createFileDurabilityStore({ root }), "recordOperationOutcome", crashAfterTool) }).host.execute({ runId, initialState: initial(runId, { request: {} }) });
    expect(effects.toolCalls).toBe(1);
    for (const start of [1000, 2000]) {
      const resumed = await world({ ...options, clock: clockAt(start) }).host.resume(runId);
      expect(!resumed.ok && resumed.failure).toMatchObject({ code: "DURABILITY_UNSAFE_REPLAY", operationId: "op.s1.a1" });
      expect(resumed.execution?.nodeStatusesById).toEqual({ work: "READY", final: "PENDING" });
    }
    expect(effects.toolCalls).toBe(1);
    expect(effects.logicalDrafts.size).toBe(1);
  });

  it("read-only recovery-safe Tool: bounded replay completes with no double commit", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const options = { yaml: toolYaml, root, effects, toolPermission: "read_only" as const, toolRetrySafety: "safe" as const };
    await world({ ...options, clock: clockAt(0), store: crashingStore(createFileDurabilityStore({ root }), "recordOperationOutcome", crashAfterTool) }).host.execute({ runId, initialState: initial(runId, { request: {} }) });
    const resumed = await world({ ...options, clock: clockAt(1000) }).host.resume(runId);
    expect(resumed.ok && resumed.execution.run.status).toBe("COMPLETED");
    expect(effects.toolCalls).toBe(2);
    expect(resumed.ok && resumed.execution.state.revision).toBe(1);
    expect(resumed.ok && resumed.execution.history.map((record) => [record.nodeId, record.attemptCount])).toEqual([["work", 1], ["final", 1]]);
  });

  it("read-only Tool without any trusted declaration is not recovery-safe", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const options = { yaml: toolYaml, root, effects, toolPermission: "read_only" as const };
    await world({ ...options, clock: clockAt(0), store: crashingStore(createFileDurabilityStore({ root }), "recordOperationOutcome", crashAfterTool) }).host.execute({ runId, initialState: initial(runId, { request: {} }) });
    const resumed = await world({ ...options, clock: clockAt(1000) }).host.resume(runId);
    expect(!resumed.ok && resumed.failure.code).toBe("DURABILITY_UNSAFE_REPLAY");
    expect(effects.toolCalls).toBe(1);
  });

  it("execution-id idempotency never enables ordinary Sprint 13 retries of write_draft", async () => {
    const tools = createToolRegistry();
    const spec = { schemaVersion: 1 as const, id: "local.x", version: "1.0.0", name: "X", inputSchema: { type: "object" }, outputSchema: { type: "object" }, permissionClasses: ["write_draft"] as PermissionClass[] };
    expect(() => tools.register({ spec, idempotency: "execution_id", retrySafety: "safe", handler: { execute: async () => ({ ok: true, output: {} }) } })).toThrow("read_only");
    expect(() => tools.register({ spec, idempotency: "maybe" as never, handler: { execute: async () => ({ ok: true, output: {} }) } })).toThrow("idempotency");
    const root = tempRoot();
    const effects = createEffects();
    const result = await world({ yaml: toolYaml, root, effects, clock: clockAt(0), toolPermission: "write_draft", toolIdempotency: "execution_id", toolScript: [{ ok: false, code: "BUSY", retryable: true }], reliability: { policiesByNodeId: { work: { maxAttempts: 3 } } } }).host.execute({ runId, initialState: initial(runId, { request: {} }) });
    expect(!result.ok && result.failure).toMatchObject({ code: "NODE_EXECUTION_FAILED", category: "TRANSIENT_DEPENDENCY" });
    expect(effects.toolCalls).toBe(1);
  });

  it.each(["external_side_effect", "destructive", "sensitive_data"] as PermissionClass[])("%s stays unsupported under durable execution, even declaring execution-id idempotency: zero handler calls", async (permissionClass) => {
    const root = tempRoot();
    const effects = createEffects();
    const w = world({ yaml: toolYaml, root, effects, clock: clockAt(0), toolPermission: permissionClass, toolIdempotency: "execution_id" });
    const result = await w.host.execute({ runId, initialState: initial(runId, { request: {} }) });
    expect(!result.ok && result.failure.code).toBe("RUNTIME_PREFLIGHT_FAILED");
    expect(JSON.stringify(!result.ok && result.failure)).toContain("TOOL_PERMISSION_UNSUPPORTED");
    expect(effects.toolCalls).toBe(0);
    // The preflight failure is itself a durable terminal Run; resume executes nothing.
    const again = await world({ yaml: toolYaml, root, effects, clock: clockAt(1000), toolPermission: permissionClass, toolIdempotency: "execution_id" }).host.resume(runId);
    expect(again.execution?.run.status).toBe("FAILED");
    expect(effects.toolCalls).toBe(0);
    expect(w.registry.get("tool")!.recoverySafety!({ node: w.plan.nodesById.work! })).toBe("unsafe");
  });
});
