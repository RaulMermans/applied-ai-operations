import { describe, expect, it } from "vitest";
import type { RunRecord } from "@aao/contracts";
import { RuntimeExecutionSnapshotSchema, captureExecutionSnapshot, validateSnapshotAgainstPlan } from "../src/execution-snapshot.js";
import { initializeNodeStatuses, transitionNodeStatus, type NodeStatusMap } from "../src/node-lifecycle.js";
import { createRunRecord, setCurrentNodeId, transitionRunRecord } from "../src/run-lifecycle.js";
import type { RuntimeExecutionState } from "../src/types.js";
import { buildRunState, buildTestClock, minimalPlan } from "./fixtures.js";

/** Builds a RUNNING RuntimeExecutionState for `minimalPlan` (intake -> final) with `intake` READY, matching the "before first Node execution" safe boundary. */
function buildRunningExecution(): RuntimeExecutionState {
  const clock = buildTestClock();
  let run: RunRecord = createRunRecord({ runId: "run.snap", workflowId: minimalPlan.workflow.id, workflowVersion: minimalPlan.workflow.version }, clock);
  run = transitionRunRecord(run, "VALIDATING", clock.now());
  run = transitionRunRecord(run, "QUEUED", clock.now());
  run = transitionRunRecord(run, "RUNNING", clock.now());
  run = setCurrentNodeId(run, "intake");
  let nodeStatusesById: NodeStatusMap = initializeNodeStatuses(Object.keys(minimalPlan.nodesById));
  nodeStatusesById = transitionNodeStatus(nodeStatusesById, "intake", "READY");
  return { run, state: buildRunState("run.snap"), nodeStatusesById, step: 0, history: [] };
}

describe("captureExecutionSnapshot", () => {
  it("captures a safe-boundary snapshot matching the execution state", () => {
    const execution = buildRunningExecution();
    const snapshot = captureExecutionSnapshot(execution, "2026-02-01T00:00:00.000Z");
    expect(snapshot).toEqual({
      schemaVersion: 2,
      run: execution.run,
      stateSnapshot: { runId: "run.snap", revision: 0, values: {}, capturedAt: "2026-02-01T00:00:00.000Z" },
      nodeStatusesById: { intake: "READY", final: "PENDING" },
      step: 0,
    });
  });

  it("throws rather than capturing a snapshot while a node is RUNNING", () => {
    const execution = buildRunningExecution();
    execution.nodeStatusesById = transitionNodeStatus(execution.nodeStatusesById, "intake", "RUNNING");
    expect(() => captureExecutionSnapshot(execution, "2026-02-01T00:00:00.000Z")).toThrow(/RUNNING/);
  });

  it("shares no mutable reference with the source execution state", () => {
    const execution = buildRunningExecution();
    const snapshot = captureExecutionSnapshot(execution, "2026-02-01T00:00:00.000Z");
    (execution.nodeStatusesById as Record<string, string>).intake = "MUTATED";
    expect(snapshot.nodeStatusesById.intake).toBe("READY");
  });

  it("round-trips through JSON.stringify -> JSON.parse -> schema validation without semantic loss", () => {
    const execution = buildRunningExecution();
    const snapshot = captureExecutionSnapshot(execution, "2026-02-01T00:00:00.000Z");
    const roundTripped = JSON.parse(JSON.stringify(snapshot));
    const validated = RuntimeExecutionSnapshotSchema.safeParse(roundTripped);
    expect(validated.success).toBe(true);
    expect(roundTripped).toEqual(snapshot);
  });
});

describe("snapshot temporal coherence (capturedAt >= run.updatedAt)", () => {
  // buildRunningExecution's last lifecycle transition is at 2026-01-01T00:00:03.000Z.
  const RUN_UPDATED_AT = "2026-01-01T00:00:03.000Z";

  it("accepts capturedAt equal to run.updatedAt", () => {
    const execution = buildRunningExecution();
    expect(execution.run.updatedAt).toBe(RUN_UPDATED_AT);
    expect(captureExecutionSnapshot(execution, RUN_UPDATED_AT).stateSnapshot.capturedAt).toBe(RUN_UPDATED_AT);
  });

  it("accepts capturedAt later than run.updatedAt", () => {
    expect(() => captureExecutionSnapshot(buildRunningExecution(), "2026-01-01T00:00:04.000Z")).not.toThrow();
  });

  it("accepts an equivalent instant written with a different UTC offset", () => {
    expect(() => captureExecutionSnapshot(buildRunningExecution(), "2026-01-01T02:00:03.000+02:00")).not.toThrow();
  });

  it("rejects capturedAt earlier than run.updatedAt at capture time", () => {
    expect(() => captureExecutionSnapshot(buildRunningExecution(), "2026-01-01T00:00:02.999Z")).toThrow(/earlier than run.updatedAt/);
    // Sorts later as a raw string, but is an earlier instant (2025-12-31T23:30:00Z).
    expect(() => captureExecutionSnapshot(buildRunningExecution(), "2026-01-01T00:30:00+01:00")).toThrow(/earlier than run.updatedAt/);
  });

  it("rejects a structurally valid snapshot whose capturedAt predates run.updatedAt, via the schema", () => {
    const snapshot = captureExecutionSnapshot(buildRunningExecution(), RUN_UPDATED_AT);
    const tampered = { ...snapshot, stateSnapshot: { ...snapshot.stateSnapshot, capturedAt: "2026-01-01T00:00:02.000Z" } };
    expect(RuntimeExecutionSnapshotSchema.safeParse(tampered).success).toBe(false);
    expect(validateSnapshotAgainstPlan(tampered, minimalPlan)?.code).toBe("INVALID_EXECUTION_SNAPSHOT");
  });
});

describe("validateSnapshotAgainstPlan", () => {
  it("accepts a snapshot that matches its originating plan", () => {
    const execution = buildRunningExecution();
    const snapshot = captureExecutionSnapshot(execution, "2026-02-01T00:00:00.000Z");
    expect(validateSnapshotAgainstPlan(snapshot, minimalPlan)).toBeUndefined();
  });

  it("rejects a snapshot whose workflowId does not match the plan", () => {
    const execution = buildRunningExecution();
    const snapshot = captureExecutionSnapshot(execution, "2026-02-01T00:00:00.000Z");
    const corrupted = { ...snapshot, run: { ...snapshot.run, workflowId: "some.other.workflow" } };
    const failure = validateSnapshotAgainstPlan(corrupted, minimalPlan);
    expect(failure?.code).toBe("INVALID_EXECUTION_SNAPSHOT");
    expect(failure?.message).toMatch(/workflowId/);
  });

  it("rejects a snapshot whose workflowVersion does not match the plan", () => {
    const execution = buildRunningExecution();
    const snapshot = captureExecutionSnapshot(execution, "2026-02-01T00:00:00.000Z");
    const corrupted = { ...snapshot, run: { ...snapshot.run, workflowVersion: "999.0.0" } };
    const failure = validateSnapshotAgainstPlan(corrupted, minimalPlan);
    expect(failure?.code).toBe("INVALID_EXECUTION_SNAPSHOT");
    expect(failure?.message).toMatch(/workflowVersion/);
  });

  it("rejects a snapshot whose run.runId does not match its own stateSnapshot.runId", () => {
    const execution = buildRunningExecution();
    const snapshot = captureExecutionSnapshot(execution, "2026-02-01T00:00:00.000Z");
    const corrupted = { ...snapshot, stateSnapshot: { ...snapshot.stateSnapshot, runId: "run.other" } };
    const failure = validateSnapshotAgainstPlan(corrupted, minimalPlan);
    expect(failure?.code).toBe("INVALID_EXECUTION_SNAPSHOT");
    expect(failure?.message).toMatch(/runId/);
  });

  it("rejects a snapshot whose nodeStatusesById keys do not match plan.nodesById keys", () => {
    const execution = buildRunningExecution();
    const snapshot = captureExecutionSnapshot(execution, "2026-02-01T00:00:00.000Z");
    const { final: _drop, ...rest } = snapshot.nodeStatusesById;
    const corrupted = { ...snapshot, nodeStatusesById: rest };
    const failure = validateSnapshotAgainstPlan(corrupted, minimalPlan);
    expect(failure?.code).toBe("INVALID_EXECUTION_SNAPSHOT");
    expect(failure?.message).toMatch(/nodeStatusesById/);
  });

  it("rejects a snapshot whose currentNodeId does not resolve in the plan", () => {
    const execution = buildRunningExecution();
    const snapshot = captureExecutionSnapshot(execution, "2026-02-01T00:00:00.000Z");
    const corrupted = { ...snapshot, run: { ...snapshot.run, currentNodeId: "does-not-exist" } };
    const failure = validateSnapshotAgainstPlan(corrupted, minimalPlan);
    expect(failure?.code).toBe("INVALID_EXECUTION_SNAPSHOT");
    expect(failure?.message).toMatch(/currentNodeId/);
  });

  it("rejects a RUNNING snapshot with no currentNodeId", () => {
    const execution = buildRunningExecution();
    const snapshot = captureExecutionSnapshot(execution, "2026-02-01T00:00:00.000Z");
    const { currentNodeId: _drop, ...runWithoutCursor } = snapshot.run;
    const corrupted = { ...snapshot, run: runWithoutCursor };
    const failure = validateSnapshotAgainstPlan(corrupted, minimalPlan);
    expect(failure?.code).toBe("INVALID_EXECUTION_SNAPSHOT");
    expect(failure?.message).toMatch(/RUNNING/);
  });

  it("rejects a RUNNING snapshot whose current node is not READY", () => {
    const execution = buildRunningExecution();
    execution.nodeStatusesById = transitionNodeStatus(execution.nodeStatusesById, "intake", "RUNNING");
    // Build the snapshot directly (bypassing captureExecutionSnapshot's own
    // RUNNING guard) to exercise validateSnapshotAgainstPlan in isolation
    // against a hand-built, externally-supplied snapshot.
    const handBuilt = {
      schemaVersion: 2 as const,
      run: execution.run,
      stateSnapshot: { runId: "run.snap", revision: 0, values: {}, capturedAt: "2026-02-01T00:00:00.000Z" },
      nodeStatusesById: execution.nodeStatusesById,
      step: 0,
    };
    const failure = validateSnapshotAgainstPlan(handBuilt, minimalPlan);
    expect(failure?.code).toBe("INVALID_EXECUTION_SNAPSHOT");
    expect(failure?.message).toMatch(/RuntimeExecutionSnapshotSchema/);
  });

  it("rejects a COMPLETED snapshot that still carries a currentNodeId", () => {
    const execution = buildRunningExecution();
    const completedRun = { ...execution.run, status: "COMPLETED" as const, currentNodeId: "final" };
    const snapshot = captureExecutionSnapshot({ ...execution, run: completedRun }, "2026-02-01T00:00:00.000Z");
    const failure = validateSnapshotAgainstPlan(snapshot, minimalPlan);
    expect(failure?.code).toBe("INVALID_EXECUTION_SNAPSHOT");
    expect(failure?.message).toMatch(/COMPLETED/);
  });

  it("rejects a COMPLETED snapshot with no SUCCEEDED terminal node", () => {
    const execution = buildRunningExecution();
    const completedRun = setCurrentNodeId({ ...execution.run, status: "COMPLETED" as const }, undefined);
    const snapshot = captureExecutionSnapshot({ ...execution, run: completedRun }, "2026-02-01T00:00:00.000Z");
    const failure = validateSnapshotAgainstPlan(snapshot, minimalPlan);
    expect(failure?.code).toBe("INVALID_EXECUTION_SNAPSHOT");
    expect(failure?.message).toMatch(/SUCCEEDED terminal node/);
  });

  it("rejects a FAILED snapshot that still carries a currentNodeId", () => {
    const execution = buildRunningExecution();
    const failedRun = { ...execution.run, status: "FAILED" as const, currentNodeId: "intake" };
    const snapshot = captureExecutionSnapshot({ ...execution, run: failedRun }, "2026-02-01T00:00:00.000Z");
    const failure = validateSnapshotAgainstPlan(snapshot, minimalPlan);
    expect(failure?.code).toBe("INVALID_EXECUTION_SNAPSHOT");
    expect(failure?.message).toMatch(/FAILED/);
  });

  it("accepts a well-formed FAILED snapshot with no currentNodeId", () => {
    const execution = buildRunningExecution();
    const failedRun = setCurrentNodeId({ ...execution.run, status: "FAILED" as const }, undefined);
    const snapshot = captureExecutionSnapshot({ ...execution, run: failedRun }, "2026-02-01T00:00:00.000Z");
    expect(validateSnapshotAgainstPlan(snapshot, minimalPlan)).toBeUndefined();
  });

  it("rejects a structurally corrupted (non-schema-conforming) snapshot with details", () => {
    const failure = validateSnapshotAgainstPlan({ not: "a snapshot" }, minimalPlan);
    expect(failure?.code).toBe("INVALID_EXECUTION_SNAPSHOT");
    expect(failure?.details).toBeDefined();
  });
});
