import { z } from "zod";
import { TRACE_TERMINAL_EVENT_TYPES, ToolIdSchema, entityVersionSchema, type RunStatus, type TraceEvent } from "@aao/contracts";
import { checkTraceEvent, validateTrace } from "@aao/observability";
import { evidenceRefs, type DeepReadonly, type EvalEvidenceBundle } from "./evidence.js";
import { gradeError, type GraderOutcome } from "./grader.js";

/**
 * Shared, read-only Trace access for graders. Every Trace-based grader
 * (other than the trace-contract grader, whose *criterion* is Trace
 * validity) first proves the Trace is trustworthy with the canonical
 * `validateTrace`: no Trace is `EVAL_EVIDENCE_MISSING`, a corrupt Trace is
 * `EVAL_EVIDENCE_INVALID`, and — where a grader needs the whole Run — a
 * Trace without a terminal event is `EVAL_REQUIRED_EVIDENCE_INCOMPLETE`.
 * Missing evidence is never a pass.
 */
export interface TraceView {
  readonly runId: string;
  readonly traceId: string;
  readonly events: readonly TraceEvent[];
  readonly terminal?: TraceEvent;
}

export type TraceRead = { ok: true; view: TraceView } | { ok: false; outcome: GraderOutcome };

export function readTrace(evidence: DeepReadonly<EvalEvidenceBundle>, options: { requireTerminal: boolean }): TraceRead {
  const raw = evidence.trace;
  if (raw === undefined || raw.length === 0) return { ok: false, outcome: gradeError("EVAL_EVIDENCE_MISSING") };
  const validation = validateTrace(raw);
  if (!validation.valid) return { ok: false, outcome: gradeError("EVAL_EVIDENCE_INVALID") };
  const events = raw.map((entry) => (checkTraceEvent(entry) as { ok: true; event: TraceEvent }).event);
  const terminal = events.find((event) => TRACE_TERMINAL_EVENT_TYPES.includes(event.type));
  if (options.requireTerminal && terminal === undefined) return { ok: false, outcome: gradeError("EVAL_REQUIRED_EVIDENCE_INCOMPLETE") };
  const first = events[0]!;
  return { ok: true, view: { runId: first.runId, traceId: first.traceId, events, ...(terminal ? { terminal } : {}) } };
}

export const payload = (event: TraceEvent) => event.payload as Record<string, unknown>;
export const ref = (event: TraceEvent) => evidenceRefs.traceEvent(event.runId, event.sequence);
export const refs = (events: readonly TraceEvent[]) => events.slice(0, 16).map(ref);

/**
 * The Run status the Trace evidences: the terminal event, else an
 * unresolved approval wait, else RUNNING (an incomplete Run).
 */
export function runStatusFromTrace(events: readonly TraceEvent[]): RunStatus {
  const terminal = events.find((event) => TRACE_TERMINAL_EVENT_TYPES.includes(event.type));
  if (terminal) return terminal.type === "run.completed" ? "COMPLETED" : terminal.type === "run.failed" ? "FAILED" : "CANCELLED";
  const resolved = new Set(events.filter((event) => event.type === "approval.resolved").map((event) => payload(event).approvalId as string));
  const waiting = events.some((event) => event.type === "node.waiting" && !resolved.has(payload(event).referenceId as string));
  return waiting ? "WAITING_FOR_APPROVAL" : "RUNNING";
}

// --- Canonical Tool identity (ToolRef), the only way Eval definitions name Tools ------------

export const ToolRefConfigSchema = z.object({ id: ToolIdSchema, version: entityVersionSchema }).strict();
export type ToolRefConfig = z.infer<typeof ToolRefConfigSchema>;

export const toolKey = (tool: { id: string; version: string }) => `${tool.id}:${tool.version}`;
export const eventToolKey = (event: TraceEvent) => toolKey(payload(event).toolRef as { id: string; version: string });
export const isTool = (event: TraceEvent, tool: ToolRefConfig) => eventToolKey(event) === toolKey(tool);

/** Uniqueness refinement for config lists. */
export function uniqueBy<T>(values: readonly T[], keyOf: (value: T) => string): boolean {
  return new Set(values.map(keyOf)).size === values.length;
}
