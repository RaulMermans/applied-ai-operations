import { AuditEventSchema, type AuditEvent } from "@aao/contracts";
import { validateAuditStream } from "@aao/observability";
import type { DeepReadonly, EvalEvidenceBundle } from "../evidence.js";
import { gradeError, type GraderOutcome } from "../grader.js";

/**
 * Read-only Audit access for compliance graders that cross-check Trace
 * against accountability evidence. Audit is required only when a definition
 * asks for the cross-check; then an absent stream is `EVAL_EVIDENCE_MISSING`
 * and a stream failing the canonical hash-chain verification is
 * `EVAL_EVIDENCE_INVALID`. Evaluation never writes Audit.
 */
export function readAudit(evidence: DeepReadonly<EvalEvidenceBundle>): { ok: true; events: AuditEvent[] } | { ok: false; outcome: GraderOutcome } {
  const raw = evidence.audit;
  if (raw === undefined || raw.length === 0) return { ok: false, outcome: gradeError("EVAL_EVIDENCE_MISSING") };
  const parsed = raw.map((entry) => AuditEventSchema.safeParse(entry));
  if (!parsed.every((entry) => entry.success) || !validateAuditStream(raw).valid) return { ok: false, outcome: gradeError("EVAL_EVIDENCE_INVALID") };
  return { ok: true, events: parsed.map((entry) => entry.data as AuditEvent) };
}
