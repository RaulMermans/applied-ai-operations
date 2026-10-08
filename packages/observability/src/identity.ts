import { createHash } from "node:crypto";
import { canonicalJsonStringify, type JsonValue, type ReliabilityPolicy, type TraceEventKey, type TraceEventType, type TraceSpanRef } from "@aao/contracts";

/**
 * Deterministic Trace identity (ADR-020). Nothing here is random, clock-,
 * process-, or model-derived, so identity survives restart and durable
 * replay: the same Run always has the same trace id, the same logical span
 * the same span id, and the same logical event the same event id.
 */

function sha256(material: JsonValue): string {
  return createHash("sha256").update(JSON.stringify(material), "utf8").digest("hex");
}

/** One canonical trace per Run: SHA-256 over trusted Run + workflow identity, truncated to the OTel 16-byte width. */
export function deriveTraceId(runId: string, workflowId: string, workflowVersion: string): string {
  return sha256(["aao.trace.v1", runId, workflowId, workflowVersion]).slice(0, 32);
}

/** OTel 8-byte span id from the span's semantic identity (see `TraceSpanRef`). */
export function deriveSpanId(traceId: string, span: TraceSpanRef): string {
  return sha256(["aao.trace-span.v1", traceId, canonicalJsonStringify(span as unknown as JsonValue)]).slice(0, 16);
}

/**
 * The semantic event key: trace + type + Node + span + the emitter's flat
 * discriminator (step, attempt, replay, ...). Re-emitting the same logical
 * event after a restart yields the same id, which the store deduplicates.
 */
export function deriveEventId(params: { traceId: string; type: TraceEventType; nodeId?: string; span: TraceSpanRef; key: TraceEventKey }): string {
  const digest = sha256(["aao.trace-event.v1", params.traceId, params.type, params.nodeId ?? null, canonicalJsonStringify(params.span as unknown as JsonValue), canonicalJsonStringify(params.key)]);
  return `evt.${digest.slice(0, 32)}`;
}

/**
 * Deterministic fingerprint of the Run's trusted Runtime reliability
 * configuration: the explicit per-Node policies plus the implied default.
 * Observability metadata only — it is not the durable plan fingerprint and
 * does not participate in durability compatibility (ADR-019/ADR-020).
 */
export function reliabilityPolicyFingerprint(policies: ReadonlyArray<ReliabilityPolicy & { nodeId: string }>): string {
  const sorted = [...policies].sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
  return createHash("sha256").update(canonicalJsonStringify({ domain: "aao.reliability-policy.v1", defaultPolicy: { maxAttempts: 1 }, policies: sorted } as unknown as JsonValue)).digest("hex");
}
