import { z } from "zod";
import { TRACE_EVENT_PAYLOAD_SCHEMAS, TRACE_EVENT_STATUS, TraceEventDraftSchema, canonicalJsonStringify, identifierSchema, isoTimestampSchema, type JsonValue, type TraceEvent, type TraceEventDraft, type TraceSpanRef } from "@aao/contracts";
import { checkTraceEvent, isTraceJsonSafe } from "./content-policy.js";
import { deriveEventId, deriveSpanId, deriveTraceId, reliabilityPolicyFingerprint } from "./identity.js";
import { traceIssueCodeOf, type TraceIssueCode, type TraceStore } from "./store.js";

/** The observability clock boundary. Tests inject a deterministic one; production uses `createSystemTraceClock()`. */
export interface TraceClock {
  now(): string;
}

export function createSystemTraceClock(): TraceClock {
  return { now: () => new Date().toISOString() };
}

/** Optional host-supplied release metadata recorded on `run.started`. No deployment infrastructure is implied. */
export const TraceReleaseSchema = z.object({ releaseId: identifierSchema.optional(), gitSha: z.string().regex(/^[a-f0-9]{7,64}$/).optional(), environment: identifierSchema.max(64).optional() }).strict();
export type TraceRelease = z.infer<typeof TraceReleaseSchema>;

export interface TraceRecorderOptions {
  store: TraceStore;
  clock?: TraceClock;
  release?: TraceRelease;
}

/** One bounded observability issue. Never a raw exception, path, or event content. */
export interface TraceIssue {
  code: TraceIssueCode;
  runId?: string;
  eventType?: string;
}

/**
 * Trace health is a separate fact from Run outcome: a Run can succeed with
 * a degraded (incomplete) trace. Nothing here ever changes `RunRecord.status`.
 */
export interface TraceHealth {
  status: "healthy" | "degraded";
  appended: number;
  deduplicated: number;
  issueCount: number;
  /** The first `MAX_RECORDED_ISSUES` issues, in order. */
  issues: TraceIssue[];
}

export const MAX_RECORDED_ISSUES = 64;

/**
 * The Trace recorder: the canonical implementation of the Runtime's
 * emit-only trace port (it satisfies `RuntimeTracePort` structurally, so
 * this package never depends on `@aao/runtime`). For each typed draft it
 * derives identity (trace id, event id, span ids), assigns the next
 * contiguous per-Run sequence (continuing from the store after a restart),
 * stamps time from its own clock — floored at the Run's last event so
 * descriptive time never runs backwards even if a restarted machine's
 * clock does — validates the result, and appends it.
 *
 * `emit` never throws or rejects. Any failure becomes a bounded issue and
 * the recorder reports `degraded`; the caller's execution is untouched, so
 * trace failure can never trigger a retry or replay. Re-emitting the same
 * logical event (same event id, same logical content) is deduplicated; the
 * same id with different content is a `TRACE_EVENT_CONFLICT` issue and the
 * stored evidence is kept.
 */
export function createTraceRecorder(options: TraceRecorderOptions) {
  const { store } = options;
  if (typeof store?.append !== "function" || typeof store.getRunTrace !== "function") throw new Error("createTraceRecorder requires a TraceStore.");
  const clock = options.clock ?? createSystemTraceClock();
  const release = options.release === undefined ? undefined : TraceReleaseSchema.parse(options.release);

  interface RunCursor { traceId?: string; nextSequence: number; lastOccurredAt?: string; logicalById: Map<string, string> }
  const cursors = new Map<string, RunCursor>();
  const chains = new Map<string, Promise<void>>();
  const issues: TraceIssue[] = [];
  const runIssues = new Map<string, number>();
  let issueCount = 0;
  let appended = 0;
  let deduplicated = 0;

  function issue(code: TraceIssueCode, runId?: string, eventType?: string): void {
    issueCount += 1;
    if (runId) runIssues.set(runId, (runIssues.get(runId) ?? 0) + 1);
    if (issues.length < MAX_RECORDED_ISSUES) issues.push({ code, ...(runId ? { runId } : {}), ...(eventType ? { eventType } : {}) });
  }

  async function cursorFor(runId: string): Promise<RunCursor> {
    const cached = cursors.get(runId);
    if (cached) return cached;
    const events = await store.getRunTrace(runId);
    const last = events[events.length - 1];
    const cursor: RunCursor = { ...(events[0] ? { traceId: events[0].traceId } : {}), nextSequence: events.length, ...(last ? { lastOccurredAt: last.occurredAt } : {}), logicalById: new Map(events.map((event) => [event.eventId, logicalForm(event)])) };
    cursors.set(runId, cursor);
    return cursor;
  }

  async function record(raw: unknown): Promise<void> {
    if (!isTraceJsonSafe(raw)) return issue("TRACE_INVALID_EVENT");
    const parsedDraft = TraceEventDraftSchema.safeParse(raw);
    if (!parsedDraft.success) return issue("TRACE_INVALID_EVENT", runIdOf(raw), typeOf(raw));
    const draft = parsedDraft.data as TraceEventDraft;
    let cursor: RunCursor;
    try { cursor = await cursorFor(draft.runId); } catch (error) { return issue(traceIssueCodeOf(error), draft.runId, draft.type); }

    const traceId = deriveTraceId(draft.runId, draft.workflowId, draft.workflowVersion);
    if (cursor.traceId !== undefined && cursor.traceId !== traceId) return issue("TRACE_EVENT_CONFLICT", draft.runId, draft.type);
    const parentSpan: TraceSpanRef | undefined = draft.parentSpan ?? (draft.span.kind === "run" ? undefined : { kind: "run" });
    const payload = draft.type === "run.started"
      ? { ...draft.payload, reliabilityPolicyFingerprint: reliabilityPolicyFingerprint(draft.payload.reliabilityPolicies), ...(release ? { release } : {}) }
      : draft.payload;
    const status = TRACE_EVENT_STATUS[draft.type];
    const candidate = {
      schemaVersion: 2,
      eventId: deriveEventId({ traceId, type: draft.type, ...(draft.nodeId ? { nodeId: draft.nodeId } : {}), span: draft.span, key: draft.key }),
      traceId,
      runId: draft.runId,
      sequence: cursor.nextSequence,
      occurredAt: flooredNow(cursor.lastOccurredAt),
      type: draft.type,
      workflowId: draft.workflowId,
      workflowVersion: draft.workflowVersion,
      ...(draft.nodeId ? { nodeId: draft.nodeId } : {}),
      spanId: deriveSpanId(traceId, draft.span),
      ...(parentSpan ? { parentSpanId: deriveSpanId(traceId, parentSpan) } : {}),
      ...(status ? { status } : {}),
      payload,
    };
    const checked = checkTraceEvent(candidate);
    if (!checked.ok) return issue(checked.code, draft.runId, draft.type);
    const event = checked.event;

    const known = cursor.logicalById.get(event.eventId);
    if (known !== undefined) {
      // The same logical event, re-emitted after a restart or recovery re-entry: deduplicate. Different content under its id: keep the stored evidence.
      if (known === logicalForm(event)) { deduplicated += 1; return; }
      return issue("TRACE_EVENT_CONFLICT", draft.runId, draft.type);
    }
    try {
      const outcome = await store.append(event);
      if (outcome === "duplicate") deduplicated += 1;
      else appended += 1;
      cursor.nextSequence = event.sequence + 1;
      cursor.traceId = traceId;
      cursor.lastOccurredAt = event.occurredAt;
      cursor.logicalById.set(event.eventId, logicalForm(event));
    } catch (error) {
      // The store may now disagree with this cursor; reload it from the store next time.
      cursors.delete(draft.runId);
      issue(traceIssueCodeOf(error), draft.runId, draft.type);
    }
  }

  function flooredNow(floor: string | undefined): string {
    const now = clock.now();
    if (!isoTimestampSchema.safeParse(now).success) return floor ?? "1970-01-01T00:00:00.000Z";
    if (floor === undefined) return now;
    return Date.parse(now) < Date.parse(floor) ? floor : now;
  }

  function health(count: number, filter?: (issue: TraceIssue) => boolean): TraceHealth {
    const shown = filter ? issues.filter(filter) : [...issues];
    return { status: count > 0 ? "degraded" : "healthy", appended, deduplicated, issueCount: count, issues: shown.map((entry) => ({ ...entry })) };
  }

  return Object.freeze({
    /** The `RuntimeTracePort` implementation. Never throws or rejects; per-Run emissions are serialized in call order. */
    emit(draft: TraceEventDraft): Promise<void> {
      const runId = runIdOf(draft) ?? "";
      const previous = chains.get(runId) ?? Promise.resolve();
      const next = previous.then(() => record(draft)).catch(() => issue("TRACE_RECORDER_FAILURE", runIdOf(draft)));
      chains.set(runId, next);
      return next;
    },
    health: (): TraceHealth => health(issueCount),
    /** Health for one Run: `degraded` means that Run's trace is known to be incomplete. */
    runHealth: (runId: string): TraceHealth => health(runIssues.get(runId) ?? 0, (entry) => entry.runId === runId),
  });
}
export type TraceRecorder = ReturnType<typeof createTraceRecorder>;

/** Logical identity of an event for deduplication: everything except recorder-assigned order and time. */
function logicalForm(event: TraceEvent): string {
  const { sequence: _sequence, occurredAt: _occurredAt, ...logical } = event;
  return canonicalJsonStringify(logical as unknown as JsonValue);
}

function runIdOf(raw: unknown): string | undefined {
  const runId = (raw as { runId?: unknown } | null)?.runId;
  return typeof runId === "string" && identifierSchema.safeParse(runId).success ? runId : undefined;
}

function typeOf(raw: unknown): string | undefined {
  const type = (raw as { type?: unknown } | null)?.type;
  return typeof type === "string" && type in TRACE_EVENT_PAYLOAD_SCHEMAS ? type : undefined;
}
