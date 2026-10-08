import { AUDIT_GENESIS_HASH, type AuditEvent } from "@aao/contracts";
import { checkAuditEvent } from "./event.js";

/**
 * Deterministic Audit stream verification (ADR-021). Returns stable
 * diagnostics; never repairs. A modified, removed, reordered, or relinked
 * committed event breaks the hash chain, and every event after a break is
 * still checked, so later valid-looking events cannot hide corruption.
 *
 * Tamper-evident, not tamper-proof: an actor with write access to the
 * whole local stream can rewrite an entire unsigned chain consistently.
 */
export const AUDIT_DIAGNOSTIC_CODES = [
  "AUDIT_INVALID_EVENT",
  "AUDIT_EVENT_TOO_LARGE",
  "AUDIT_FORBIDDEN_CONTENT",
  "AUDIT_STREAM_MISMATCH",
  "AUDIT_SEQUENCE_GAP",
  "AUDIT_DUPLICATE_EVENT",
  "AUDIT_PREVIOUS_HASH_MISMATCH",
  "AUDIT_HASH_MISMATCH",
  "AUDIT_EVENT_ORDER_VIOLATION",
] as const;
export type AuditDiagnosticCode = (typeof AUDIT_DIAGNOSTIC_CODES)[number];

export interface AuditDiagnostic {
  code: AuditDiagnosticCode;
  /** Position in the verified list (the expected sequence). */
  index: number;
}

export interface AuditValidationResult {
  valid: boolean;
  issues: AuditDiagnostic[];
}

/**
 * `integrityOnly` checks schema, size, content, identity, sequence, and the
 * hash chain — what a store requires before it will extend a stream. The
 * default additionally checks event-order invariants, which also reveal
 * missing evidence (e.g. a resolution whose request was never recorded
 * because Audit was degraded at that moment).
 */
export function validateAuditStream(events: readonly unknown[], options: { streamId?: string; integrityOnly?: boolean } = {}): AuditValidationResult {
  const issues: AuditDiagnostic[] = [];
  const add = (code: AuditDiagnosticCode, index: number) => issues.push({ code, index });
  const ids = new Set<string>();
  let expectedPrevious = AUDIT_GENESIS_HASH;
  let streamId = options.streamId;
  const requested = new Set<string>();
  const resolved = new Set<string>();
  let cancellationRequested = false;
  let cancellationApplied = false;

  events.forEach((raw, index) => {
    const record = (raw ?? {}) as Record<string, unknown>;
    const checked = checkAuditEvent(raw);
    if (!checked.ok) add(checked.code, index);

    // Chain linkage over the stored fields, valid event or not.
    if (record.previousHash !== expectedPrevious) add("AUDIT_PREVIOUS_HASH_MISMATCH", index);
    expectedPrevious = typeof record.eventHash === "string" ? record.eventHash : "";
    if (record.sequence !== index) add("AUDIT_SEQUENCE_GAP", index);
    if (typeof record.streamId === "string") {
      streamId ??= record.streamId;
      if (record.streamId !== streamId) add("AUDIT_STREAM_MISMATCH", index);
    }
    if (typeof record.eventId === "string") {
      if (ids.has(record.eventId)) add("AUDIT_DUPLICATE_EVENT", index);
      ids.add(record.eventId);
    }
    if (!checked.ok || options.integrityOnly) return;
    checkOrder(checked.event, index);
  });
  return { valid: issues.length === 0, issues };

  /** Event-specific invariants: a resolution follows its request, once; cancellation is applied after it is requested, once. */
  function checkOrder(event: AuditEvent, index: number): void {
    const approvalId = event.payload.approvalId as string | undefined;
    switch (event.type) {
      case "approval.requested":
        requested.add(approvalId!);
        break;
      case "approval.resolved":
        if (!requested.has(approvalId!) || resolved.has(approvalId!)) add("AUDIT_EVENT_ORDER_VIOLATION", index);
        resolved.add(approvalId!);
        break;
      case "approval.resolution_denied":
        if (!requested.has(approvalId!)) add("AUDIT_EVENT_ORDER_VIOLATION", index);
        break;
      case "run.cancellation.requested":
        cancellationRequested = true;
        break;
      case "run.cancellation.applied":
        if (!cancellationRequested || cancellationApplied) add("AUDIT_EVENT_ORDER_VIOLATION", index);
        cancellationApplied = true;
        break;
      default:
        break;
    }
  }
}
