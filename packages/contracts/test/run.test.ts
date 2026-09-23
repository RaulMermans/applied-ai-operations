import { describe, expect, it } from "vitest";
import { NodeStatusSchema, RunRecordSchema, RunStatusSchema } from "../src/run.js";
import { runRecordFixture } from "./fixtures.js";

const CANONICAL_RUN_STATUSES = [
  "CREATED",
  "VALIDATING",
  "QUEUED",
  "RUNNING",
  "WAITING_FOR_APPROVAL",
  "RETRYING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

const CANONICAL_NODE_STATUSES = [
  "PENDING",
  "READY",
  "RUNNING",
  "WAITING",
  "SUCCEEDED",
  "FAILED",
  "SKIPPED",
  "CANCELLED",
] as const;

describe("RunStatusSchema", () => {
  it.each(CANONICAL_RUN_STATUSES.map((status) => [status]))("accepts canonical run status %s", (status) => {
    expect(RunStatusSchema.safeParse(status).success).toBe(true);
  });

  it("rejects a non-canonical run status", () => {
    expect(RunStatusSchema.safeParse("PAUSED").success).toBe(false);
    expect(RunStatusSchema.safeParse("running").success).toBe(false);
  });
});

describe("NodeStatusSchema", () => {
  it.each(CANONICAL_NODE_STATUSES.map((status) => [status]))("accepts canonical node status %s", (status) => {
    expect(NodeStatusSchema.safeParse(status).success).toBe(true);
  });

  it("rejects a non-canonical node status", () => {
    expect(NodeStatusSchema.safeParse("BLOCKED").success).toBe(false);
  });
});

describe("RunRecordSchema", () => {
  it("parses a valid run record", () => {
    expect(RunRecordSchema.safeParse(runRecordFixture).success).toBe(true);
  });

  it("parses without the optional currentNodeId", () => {
    const { currentNodeId: _currentNodeId, ...withoutCurrentNode } = runRecordFixture;
    expect(RunRecordSchema.safeParse(withoutCurrentNode).success).toBe(true);
  });

  it("rejects a missing required field", () => {
    const { status: _status, ...missingStatus } = runRecordFixture;
    expect(RunRecordSchema.safeParse(missingStatus).success).toBe(false);
  });

  it("rejects an invalid status", () => {
    expect(RunRecordSchema.safeParse({ ...runRecordFixture, status: "PAUSED" }).success).toBe(false);
  });

  it("rejects an unexpected top-level field", () => {
    expect(RunRecordSchema.safeParse({ ...runRecordFixture, unexpected: true }).success).toBe(false);
  });

  it("rejects the wrong schemaVersion", () => {
    expect(RunRecordSchema.safeParse({ ...runRecordFixture, schemaVersion: 2 }).success).toBe(false);
  });
});
