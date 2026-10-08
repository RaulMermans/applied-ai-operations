import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";
import { RunStateSchema, StateSnapshotSchema } from "../src/state.js";

const validRunState = { runId: "run-0001", revision: 0, values: { leadScore: 42 } };
const validSnapshot = { ...validRunState, capturedAt: "2026-09-23T12:00:00Z" };

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

describe("checkpoint contract ownership (ADR-019)", () => {
  it("exports no placeholder CheckpointRecord: the canonical durable checkpoint lives in @aao/durability", () => {
    expect(Object.keys(contracts)).not.toContain("CheckpointRecordSchema");
  });
});
