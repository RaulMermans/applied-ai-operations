import { checkAuditEvent } from "./audit/event.js";
import type { AuditHealth } from "./audit/recorder.js";
import { checkTraceEvent } from "./content-policy.js";
import type { TraceHealth } from "./recorder.js";

/**
 * One bounded observability health summary (ADR-021). Trace and Audit are
 * separate evidence channels with separate health; Metrics projection
 * quality (`complete | partial | invalid`) is a third, separate fact.
 * Collapsing them would let one channel vouch for another.
 */
export interface ObservabilityHealth {
  trace: "healthy" | "degraded" | "not_configured";
  audit: "healthy" | "degraded" | "not_configured";
}

export function summarizeObservabilityHealth(params: { trace?: Pick<TraceHealth, "status">; audit?: Pick<AuditHealth, "status"> }): ObservabilityHealth {
  return { trace: params.trace?.status ?? "not_configured", audit: params.audit?.status ?? "not_configured" };
}

export interface MissingAuditEvidence {
  /** The source-time Audit event type that should exist. */
  auditType: "approval.requested" | "approval.resolved" | "tool.access.allowed" | "tool.access.denied" | "run.cancellation.requested" | "run.cancellation.applied";
  /** The Trace event sequence that reveals the expectation. */
  traceSequence: number;
}

export interface AuditCompleteness {
  status: "complete" | "degraded";
  missing: MissingAuditEvidence[];
}

/**
 * Cross-checks one Run's Audit stream against its Trace to reveal *missing*
 * accountability evidence (e.g. an Approval resolution the Runtime consumed
 * while the Audit store was failing). It only reports gaps: a Trace event is
 * never accepted as, or converted into, an Audit record — they carry
 * different guarantees. Expectations are limited to channels the host
 * audited: pass `audited` to skip families it never wired an Audit port for.
 */
export function checkAuditCompleteness(params: { trace: readonly unknown[]; audit: readonly unknown[]; audited?: { approvals?: boolean; tools?: boolean; cancellation?: boolean } }): AuditCompleteness {
  const audited = { approvals: true, tools: true, cancellation: true, ...params.audited };
  const audit = params.audit.flatMap((raw) => { const checked = checkAuditEvent(raw); return checked.ok ? [checked.event] : []; });
  const has = (type: string, match: (payload: Record<string, unknown>) => boolean) => audit.some((event) => event.type === type && match(event.payload));
  const missing: MissingAuditEvidence[] = [];
  for (const raw of params.trace) {
    const checked = checkTraceEvent(raw);
    if (!checked.ok) continue;
    const event = checked.event;
    const payload = event.payload;
    const expect = (auditType: MissingAuditEvidence["auditType"], present: boolean) => { if (!present) missing.push({ auditType, traceSequence: event.sequence }); };
    if (audited.approvals && event.type === "approval.requested") expect("approval.requested", has("approval.requested", (entry) => entry.approvalId === payload.approvalId));
    if (audited.approvals && event.type === "approval.resolved" && (payload.status === "approved" || payload.status === "rejected")) expect("approval.resolved", has("approval.resolved", (entry) => entry.approvalId === payload.approvalId));
    if (audited.tools && event.type === "tool.call.started") expect("tool.access.allowed", has("tool.access.allowed", (entry) => entry.toolExecutionId === payload.toolExecutionId && entry.attempt === payload.attempt));
    if (audited.tools && event.type === "tool.call.blocked" && (payload.access as { decision?: string } | undefined)?.decision === "deny") expect("tool.access.denied", has("tool.access.denied", (entry) => entry.toolExecutionId === payload.toolExecutionId && entry.attempt === payload.attempt));
    if (audited.cancellation && event.type === "cancellation.requested") expect("run.cancellation.requested", has("run.cancellation.requested", () => true));
    if (audited.cancellation && event.type === "cancellation.applied") expect("run.cancellation.applied", has("run.cancellation.applied", () => true));
  }
  return { status: missing.length === 0 ? "complete" : "degraded", missing };
}
