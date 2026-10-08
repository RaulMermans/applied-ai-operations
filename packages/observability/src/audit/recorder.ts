import { AUDIT_EVENT_ACTION, AUDIT_GENESIS_HASH, AUDIT_SOURCE_TIMED_EVENT_TYPES, AuditEventDraftSchema, auditOutcomeOf, auditStreamIdForRun, canonicalJsonStringify, identifierSchema, isoTimestampSchema, type AuditEvent, type AuditEventDraft, type AuditEventType, type JsonValue } from "@aao/contracts";
import { isTraceJsonSafe } from "../content-policy.js";
import { checkAuditEvent, computeAuditEventHash, deriveAuditEventId } from "./event.js";
import { auditIssueCodeOf, type AuditIssueCode, type AuditStore } from "./store.js";

/** The Audit clock boundary. Used only for decisions whose source record carries no time (Tool access). */
export interface AuditClock {
  now(): string;
}

export function createSystemAuditClock(): AuditClock {
  return { now: () => new Date().toISOString() };
}

/** One bounded Audit issue. Never a raw exception, path, or event content. */
export interface AuditIssue {
  code: AuditIssueCode;
  streamId?: string;
  eventType?: string;
}

/** Audit health is a separate fact from every execution outcome: an Approval or Run can succeed with degraded Audit. */
export interface AuditHealth {
  status: "healthy" | "degraded";
  appended: number;
  deduplicated: number;
  issueCount: number;
  issues: AuditIssue[];
}

export const MAX_RECORDED_AUDIT_ISSUES = 64;

/**
 * The Audit recorder (ADR-021): the canonical implementation of the
 * emit-only `AuditPort` from `@aao/contracts`. For each typed draft it
 * derives the stream (`run:<runId>`) and a deterministic event id, takes the
 * authoritative source time from the draft (or, only for types without a
 * source time, its own trusted clock), assigns the next contiguous
 * sequence and `previousHash` (continuing from the store after a restart),
 * computes `eventHash`, validates, and appends.
 *
 * `emit` never throws or rejects into execution. Any failure becomes a
 * bounded issue and the recorder reports `degraded`; the authoritative
 * action is never rolled back or retried. Re-emitting the same logical
 * event is deduplicated; the same id with different content is
 * `AUDIT_EVENT_CONFLICT` and the stored evidence is kept. No global
 * singleton: a host constructs and injects it explicitly.
 */
export function createAuditRecorder(options: { store: AuditStore; clock?: AuditClock }) {
  const { store } = options;
  if (typeof store?.append !== "function" || typeof store.getStream !== "function") throw new Error("createAuditRecorder requires an AuditStore.");
  const clock = options.clock ?? createSystemAuditClock();

  interface StreamCursor { nextSequence: number; lastHash: string; logicalById: Map<string, string> }
  const cursors = new Map<string, StreamCursor>();
  const chains = new Map<string, Promise<void>>();
  const issues: AuditIssue[] = [];
  const streamIssues = new Map<string, number>();
  let issueCount = 0;
  let appended = 0;
  let deduplicated = 0;

  function issue(code: AuditIssueCode, streamId?: string, eventType?: string): void {
    issueCount += 1;
    if (streamId) streamIssues.set(streamId, (streamIssues.get(streamId) ?? 0) + 1);
    if (issues.length < MAX_RECORDED_AUDIT_ISSUES) issues.push({ code, ...(streamId ? { streamId } : {}), ...(eventType ? { eventType } : {}) });
  }

  async function cursorFor(streamId: string): Promise<StreamCursor> {
    const cached = cursors.get(streamId);
    if (cached) return cached;
    const events = await store.getStream(streamId);
    const cursor: StreamCursor = { nextSequence: events.length, lastHash: events[events.length - 1]?.eventHash ?? AUDIT_GENESIS_HASH, logicalById: new Map(events.map((event) => [event.eventId, logicalForm(event)])) };
    cursors.set(streamId, cursor);
    return cursor;
  }

  async function record(raw: unknown, streamId: string | undefined): Promise<void> {
    if (!isTraceJsonSafe(raw)) return issue("AUDIT_INVALID_EVENT", streamId);
    const parsed = AuditEventDraftSchema.safeParse(raw);
    if (!parsed.success || streamId === undefined) return issue("AUDIT_INVALID_EVENT", streamId, typeOf(raw));
    const draft = parsed.data as AuditEventDraft;
    const occurredAt = draft.occurredAt ?? clock.now();
    if (!isoTimestampSchema.safeParse(occurredAt).success) return issue("AUDIT_RECORDER_FAILURE", streamId, draft.type);
    let cursor: StreamCursor;
    try { cursor = await cursorFor(streamId); } catch (error) { return issue(auditIssueCodeOf(error), streamId, draft.type); }

    const content = {
      schemaVersion: 1 as const,
      eventId: deriveAuditEventId({ streamId, type: draft.type, key: draft.key }),
      streamId,
      sequence: cursor.nextSequence,
      occurredAt,
      type: draft.type,
      runId: draft.runId,
      actor: { id: draft.actor.id, type: draft.actor.type },
      action: AUDIT_EVENT_ACTION[draft.type],
      target: draft.target,
      outcome: auditOutcomeOf(draft.type, draft.payload as Record<string, unknown>),
      payload: draft.payload as Record<string, unknown>,
      previousHash: cursor.lastHash,
    };
    const checked = checkAuditEvent({ ...content, eventHash: computeAuditEventHash(content) });
    if (!checked.ok) return issue(checked.code, streamId, draft.type);
    const event = checked.event;

    const known = cursor.logicalById.get(event.eventId);
    if (known !== undefined) {
      // The same logical event re-emitted (exact-request replay, restart): deduplicate. Different content under its id: keep the stored evidence.
      if (known === logicalForm(event)) { deduplicated += 1; return; }
      return issue("AUDIT_EVENT_CONFLICT", streamId, draft.type);
    }
    try {
      const outcome = await store.append(event);
      if (outcome === "duplicate") deduplicated += 1;
      else appended += 1;
      cursor.nextSequence = event.sequence + 1;
      cursor.lastHash = event.eventHash;
      cursor.logicalById.set(event.eventId, logicalForm(event));
    } catch (error) {
      cursors.delete(streamId);
      issue(auditIssueCodeOf(error), streamId, draft.type);
    }
  }

  function health(count: number, filter?: (entry: AuditIssue) => boolean): AuditHealth {
    const shown = filter ? issues.filter(filter) : [...issues];
    return { status: count > 0 ? "degraded" : "healthy", appended, deduplicated, issueCount: count, issues: shown.map((entry) => ({ ...entry })) };
  }

  return Object.freeze({
    /** The `AuditPort` implementation. Never throws or rejects; emissions to one stream are serialized in call order. */
    emit(draft: AuditEventDraft): Promise<void> {
      const streamId = streamIdOf(draft);
      const key = streamId ?? "";
      const previous = chains.get(key) ?? Promise.resolve();
      const next = previous.then(() => record(draft, streamId)).catch(() => issue("AUDIT_RECORDER_FAILURE", streamId));
      chains.set(key, next);
      return next;
    },
    /** Resolves once every emission accepted so far has been recorded or turned into an issue. */
    async flush(): Promise<void> {
      await Promise.all([...chains.values()]);
    },
    health: (): AuditHealth => health(issueCount),
    /** Health for one stream: `degraded` means that stream's Audit evidence is known to be incomplete. */
    streamHealth: (streamId: string): AuditHealth => health(streamIssues.get(streamId) ?? 0, (entry) => entry.streamId === streamId),
  });
}
export type AuditRecorder = ReturnType<typeof createAuditRecorder>;

/**
 * Logical identity of an event for deduplication: everything except the
 * recorder-assigned sequence and hashes, and — only for types without a
 * source time — the recorder-stamped `occurredAt`. A source-timed event
 * (e.g. `approval.resolved` at `resolvedAt`) is never the same event at a
 * different time.
 */
function logicalForm(event: AuditEvent): string {
  const { sequence: _sequence, previousHash: _previousHash, eventHash: _eventHash, occurredAt, ...logical } = event;
  const timed = AUDIT_SOURCE_TIMED_EVENT_TYPES.includes(event.type as AuditEventType);
  return canonicalJsonStringify({ ...logical, ...(timed ? { occurredAt } : {}) } as unknown as JsonValue);
}

function streamIdOf(raw: unknown): string | undefined {
  const runId = (raw as { runId?: unknown } | null)?.runId;
  return typeof runId === "string" && identifierSchema.safeParse(runId).success ? auditStreamIdForRun(runId) : undefined;
}

function typeOf(raw: unknown): string | undefined {
  const type = (raw as { type?: unknown } | null)?.type;
  return typeof type === "string" && type in AUDIT_EVENT_ACTION ? type : undefined;
}
