import { describe, expect, it } from "vitest";
import { CheckpointRecordSchema, RunStateSchema, StateSnapshotSchema } from "../src/state.js";

const validRunState = { runId: "run-0001", revision: 0, values: { leadScore: 42 } };
const validSnapshot = { ...validRunState, capturedAt: "2026-09-23T12:00:00Z" };
const validCheckpoint = {
  schemaVersion: 1 as const,
  checkpointId: "checkpoint-0001",
  runId: "run-0001",
  stateRevision: 0,
  createdAt: "2026-09-23T12:00:00Z",
  stateSnapshot: validSnapshot,
};

describe("RunStateSchema", () => {
  it("parses a valid run state", () => {
    expect(RunStateSchema.safeParse(validRunState).success).toBe(true);
  });

  it("rejects a negative revision", () => {
    expect(RunStateSchema.safeParse({ ...validRunState, revision: -1 }).success).toBe(false);
  });
});

describe("StateSnapshotSchema", () => {
  it("parses a valid snapshot", () => {
    expect(StateSnapshotSchema.safeParse(validSnapshot).success).toBe(true);
  });

  it("rejects a snapshot missing capturedAt", () => {
    const { capturedAt: _capturedAt, ...malformed } = validSnapshot;
    expect(StateSnapshotSchema.safeParse(malformed).success).toBe(false);
  });
});

describe("CheckpointRecordSchema", () => {
  it("parses a valid checkpoint record", () => {
    expect(CheckpointRecordSchema.safeParse(validCheckpoint).success).toBe(true);
  });

  it("rejects a checkpoint with a malformed embedded snapshot", () => {
    expect(
      CheckpointRecordSchema.safeParse({ ...validCheckpoint, stateSnapshot: { runId: "run-0001" } }).success,
    ).toBe(false);
  });

  it("makes no durability or exactly-once claim in its shape (documentation-level check)", () => {
    // The schema itself carries no field implying transactional or crash-safe
    // guarantees (e.g. no "durable: true" flag) — it is recovery state only.
    expect(Object.keys(CheckpointRecordSchema.shape)).not.toContain("durable");
    expect(Object.keys(CheckpointRecordSchema.shape)).not.toContain("exactlyOnce");
  });
});
