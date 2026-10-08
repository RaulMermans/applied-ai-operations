import { describe, expect, it } from "vitest";
import { TRACE_EVENT_PAYLOAD_SCHEMAS, TRACE_EVENT_STATUS, TRACE_EVENT_TYPES, TraceEventDraftSchema, TraceEventSchema } from "../src/trace.js";

export const nodeStartedEvent = {
  schemaVersion: 2 as const,
  eventId: "evt.0123456789abcdef0123456789abcdef",
  traceId: "0123456789abcdef0123456789abcdef",
  runId: "run-0001",
  sequence: 1,
  occurredAt: "2026-10-08T12:00:00Z",
  type: "node.started" as const,
  workflowId: "sales.lead-qualification",
  workflowVersion: "1.0.0",
  nodeId: "prepare",
  spanId: "0123456789abcdef",
  parentSpanId: "fedcba9876543210",
  status: "started" as const,
  payload: { kind: "deterministic", step: 1, attempt: 1, maxAttempts: 1, stateRevision: 0, recoveryReplay: false },
};

describe("TraceEventSchema (schema version 2)", () => {
  it("parses a valid typed event", () => {
    expect(TraceEventSchema.safeParse(nodeStartedEvent).success).toBe(true);
  });

  it("rejects the migrated schema version 1 envelope", () => {
    expect(TraceEventSchema.safeParse({ ...nodeStartedEvent, schemaVersion: 1 }).success).toBe(false);
  });

  it("rejects an event type outside the catalog (no arbitrary untyped events)", () => {
    expect(TraceEventSchema.safeParse({ ...nodeStartedEvent, type: "run.status_changed" }).success).toBe(false);
    expect(TraceEventSchema.safeParse({ ...nodeStartedEvent, type: "retrieval.started" }).success).toBe(false);
  });

  it("rejects a payload that does not match its type's strict schema", () => {
    expect(TraceEventSchema.safeParse({ ...nodeStartedEvent, payload: { ...nodeStartedEvent.payload, input: { secret: "x" } } }).success).toBe(false);
    expect(TraceEventSchema.safeParse({ ...nodeStartedEvent, payload: { kind: "deterministic" } }).success).toBe(false);
  });

  it("requires exactly the canonical status for the type", () => {
    expect(TraceEventSchema.safeParse({ ...nodeStartedEvent, status: "succeeded" }).success).toBe(false);
    const { status: _status, ...withoutStatus } = nodeStartedEvent;
    expect(TraceEventSchema.safeParse(withoutStatus).success).toBe(false);
  });

  it("rejects negative or fractional sequences, bad timestamps, and non-hex ids", () => {
    expect(TraceEventSchema.safeParse({ ...nodeStartedEvent, sequence: -1 }).success).toBe(false);
    expect(TraceEventSchema.safeParse({ ...nodeStartedEvent, sequence: 1.5 }).success).toBe(false);
    expect(TraceEventSchema.safeParse({ ...nodeStartedEvent, occurredAt: "yesterday" }).success).toBe(false);
    expect(TraceEventSchema.safeParse({ ...nodeStartedEvent, traceId: "XYZ" }).success).toBe(false);
    expect(TraceEventSchema.safeParse({ ...nodeStartedEvent, spanId: "0123" }).success).toBe(false);
  });

  it("rejects a span that is its own parent and unknown envelope fields", () => {
    expect(TraceEventSchema.safeParse({ ...nodeStartedEvent, parentSpanId: nodeStartedEvent.spanId }).success).toBe(false);
    expect(TraceEventSchema.safeParse({ ...nodeStartedEvent, stack: "Error: at x" }).success).toBe(false);
  });

  it("survives JSON round-trip with equality", () => {
    const parsed = TraceEventSchema.parse(nodeStartedEvent);
    expect(TraceEventSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });
});

describe("Trace event catalog", () => {
  it("uses one dot-namespaced naming convention", () => {
    for (const type of TRACE_EVENT_TYPES) expect(type).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
  });

  it("does not contain fake events for systems that do not exist yet", () => {
    for (const type of TRACE_EVENT_TYPES) expect(type).not.toMatch(/^(retrieval|eval|artifact|memory)\.|side_effect/);
  });

  it("gives every type a strict payload schema and only catalog types a status", () => {
    for (const type of TRACE_EVENT_TYPES) expect(TRACE_EVENT_PAYLOAD_SCHEMAS[type]).toBeDefined();
    for (const type of Object.keys(TRACE_EVENT_STATUS)) expect(TRACE_EVENT_TYPES).toContain(type);
  });
});

describe("TraceEventDraftSchema", () => {
  const draft = { type: "route.selected", runId: "run-0001", workflowId: "wf", workflowVersion: "1", span: { kind: "run" }, key: { step: 1 }, payload: { sourceNodeId: "a", targetNodeId: "b", routeType: "unconditional" } };

  it("accepts a typed draft", () => {
    expect(TraceEventDraftSchema.safeParse(draft).success).toBe(true);
  });

  it("rejects recorder-owned fields and untyped payloads", () => {
    expect(TraceEventDraftSchema.safeParse({ ...draft, sequence: 3 }).success).toBe(false);
    expect(TraceEventDraftSchema.safeParse({ ...draft, payload: { anything: "anything" } }).success).toBe(false);
  });

  it("does not let an emitter supply the recorder-derived run.started fingerprint", () => {
    const started = { ...draft, type: "run.started", payload: { entryNodeId: "a", initialStateRevision: 0, nodeCount: 2, reliabilityPolicies: [] } };
    expect(TraceEventDraftSchema.safeParse(started).success).toBe(true);
    expect(TraceEventDraftSchema.safeParse({ ...started, payload: { ...started.payload, reliabilityPolicyFingerprint: "a".repeat(64) } }).success).toBe(false);
  });
});
