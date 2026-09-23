import { describe, expect, it } from "vitest";
import { TraceEventSchema } from "../src/trace.js";

const validEvent = {
  schemaVersion: 1 as const,
  eventId: "trace-event-0001",
  runId: "run-0001",
  sequence: 0,
  occurredAt: "2026-09-23T12:00:00Z",
  type: "run.status_changed",
  payload: { from: "CREATED", to: "VALIDATING" },
};

describe("TraceEventSchema", () => {
  it("parses a valid event envelope", () => {
    expect(TraceEventSchema.safeParse(validEvent).success).toBe(true);
  });

  it("parses without the optional nodeId", () => {
    expect(TraceEventSchema.safeParse(validEvent).success).toBe(true);
  });

  it("parses with an optional nodeId", () => {
    expect(TraceEventSchema.safeParse({ ...validEvent, nodeId: "n1", type: "node.started" }).success).toBe(true);
  });

  it("rejects a negative sequence", () => {
    expect(TraceEventSchema.safeParse({ ...validEvent, sequence: -1 }).success).toBe(false);
  });

  it("rejects a non-integer sequence", () => {
    expect(TraceEventSchema.safeParse({ ...validEvent, sequence: 1.5 }).success).toBe(false);
  });

  it("rejects an invalid occurredAt timestamp", () => {
    expect(TraceEventSchema.safeParse({ ...validEvent, occurredAt: "yesterday" }).success).toBe(false);
  });

  it("requires a JSON-safe payload", () => {
    expect(TraceEventSchema.safeParse({ ...validEvent, payload: { cb: () => 1 } }).success).toBe(false);
  });
});
