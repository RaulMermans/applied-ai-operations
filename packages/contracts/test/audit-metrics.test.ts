import { describe, expect, it } from "vitest";
import {
  AUDIT_EVENT_TYPES,
  AUDIT_GENESIS_HASH,
  AuditEventDraftSchema,
  AuditEventSchema,
  ModelPricingProfileSchema,
  MetricRateSchema,
  auditStreamIdForRun,
  emitAuditSafely,
  type AuditEventDraft,
} from "../src/index.js";

const event = {
  schemaVersion: 1,
  eventId: `aud.${"1".repeat(32)}`,
  streamId: "run:run.audit",
  sequence: 0,
  occurredAt: "2026-10-08T12:00:00.000Z",
  type: "approval.resolved",
  runId: "run.audit",
  actor: { id: "user.bob", type: "user" },
  action: "approval.resolve",
  target: { kind: "approval", approvalId: "approval:1" },
  outcome: "approved",
  payload: { approvalId: "approval:1", nodeId: "approval", decision: "approved", requestFingerprint: "a".repeat(64) },
  previousHash: AUDIT_GENESIS_HASH,
  eventHash: "b".repeat(64),
};

describe("AuditEvent contract (schema version 1)", () => {
  it("accepts a valid event and survives a JSON round trip", () => {
    expect(AuditEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });

  it("has a closed catalog of only real AAO capabilities", () => {
    expect(AUDIT_EVENT_TYPES).toEqual(["approval.requested", "approval.resolution_denied", "approval.resolved", "run.cancellation.applied", "run.cancellation.requested", "tool.access.allowed", "tool.access.denied"]);
    for (const invented of ["policy.changed", "operator.override", "kill_switch.changed", "side_effect.executed", "deployment.changed", "secret.rotated"]) expect(AuditEventSchema.safeParse({ ...event, type: invented }).success).toBe(false);
  });

  it.each([
    ["an unexpected envelope field", { ...event, email: "bob@example.com" }],
    ["an unexpected payload field (subject)", { ...event, payload: { ...event.payload, subject: { amount: 10 } } }],
    ["actor profile data", { ...event, actor: { id: "user.bob", type: "user", displayName: "Bob" } }],
    ["a non-canonical outcome", { ...event, outcome: "rejected" }],
    ["a non-canonical action", { ...event, action: "approval.override" }],
    ["a target of the wrong kind", { ...event, target: { kind: "run", runId: "run.audit" } }],
    ["a target that disagrees with the payload", { ...event, target: { kind: "approval", approvalId: "approval:2" } }],
    ["a stream that is not the Run's", { ...event, streamId: "run:run.other" }],
    ["a first event not chained from genesis", { ...event, previousHash: "c".repeat(64) }],
    ["a malformed event id", { ...event, eventId: "evt.123" }],
  ])("rejects %s", (_name, candidate) => {
    expect(AuditEventSchema.safeParse(candidate).success).toBe(false);
  });

  it("derives Run stream ids deterministically", () => {
    expect(auditStreamIdForRun("run.audit")).toBe("run:run.audit");
  });
});

describe("AuditEventDraft", () => {
  const draft: AuditEventDraft = { type: "approval.resolved", runId: "run.audit", actor: { id: "user.bob", type: "user" }, target: { kind: "approval", approvalId: "approval:1" }, occurredAt: "2026-10-08T12:00:00.000Z", key: { approvalId: "approval:1" }, payload: { approvalId: "approval:1", nodeId: "approval", decision: "approved", requestFingerprint: "a".repeat(64) } };

  it("requires the authoritative source time for source-timed types", () => {
    expect(AuditEventDraftSchema.safeParse(draft).success).toBe(true);
    const { occurredAt: _occurredAt, ...untimed } = draft;
    expect(AuditEventDraftSchema.safeParse(untimed).success).toBe(false);
  });

  it("allows recorder time only for decisions without a source time (Tool access)", () => {
    const tool = { type: "tool.access.allowed", runId: "run.audit", actor: { id: "user.alice", type: "user" }, target: { kind: "tool", toolId: "local.lookup", toolVersion: "1.0.0" }, key: { toolExecutionId: "tool.1", attempt: 1 }, payload: { toolExecutionId: "tool.1", attempt: 1, permissionClasses: ["read_only"], agentCeilingApplied: false } };
    expect(AuditEventDraftSchema.safeParse(tool).success).toBe(true);
    expect(AuditEventDraftSchema.safeParse({ ...tool, payload: { ...tool.payload, input: { q: "x" } } }).success).toBe(false);
    expect(AuditEventDraftSchema.safeParse({ ...tool, target: { kind: "approval", approvalId: "approval:1" } }).success).toBe(false);
  });

  it("emitAuditSafely never lets a port failure reach the caller", async () => {
    expect(() => emitAuditSafely(undefined, draft)).not.toThrow();
    expect(() => emitAuditSafely({ emit: () => { throw new Error("audit down"); } }, draft)).not.toThrow();
    const rejected = Promise.reject(new Error("audit down"));
    expect(() => emitAuditSafely({ emit: () => rejected }, draft)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe("Metrics contracts", () => {
  it("pricing profiles are strict integer nano-unit configuration", () => {
    const profile = { schemaVersion: 1, profileId: "pricing.example", profileVersion: "2026-01", provider: "example", model: "example-model", currency: "USD", inputNanosPerMillionTokens: 3_000_000_000, outputNanosPerMillionTokens: 15_000_000_000 };
    expect(ModelPricingProfileSchema.parse(profile)).toEqual(profile);
    expect(ModelPricingProfileSchema.safeParse({ ...profile, inputNanosPerMillionTokens: 0.003 }).success).toBe(false);
    expect(ModelPricingProfileSchema.safeParse({ ...profile, currency: "usd" }).success).toBe(false);
    expect(ModelPricingProfileSchema.safeParse({ ...profile, source: "https://example.com/pricing" }).success).toBe(false);
  });

  it("a rate always carries its denominator; an empty denominator has no value", () => {
    expect(MetricRateSchema.safeParse({ numerator: 0, denominator: 0, value: null }).success).toBe(true);
    expect(MetricRateSchema.safeParse({ value: 0.5 }).success).toBe(false);
  });
});
