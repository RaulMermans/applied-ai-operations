import { RunIdSchema, TraceEventIdSchema, type TraceEvent } from "@aao/contracts";
import { checkTraceEvent, serializeTraceEvent } from "./content-policy.js";

/**
 * Trace-infrastructure issue codes. They describe observability itself and
 * are never Runtime failure codes: a Run's outcome does not change because
 * any of them occurred (ADR-020).
 */
export const TRACE_ISSUE_CODES = [
  "TRACE_INVALID_EVENT",
  "TRACE_EVENT_CONFLICT",
  "TRACE_SEQUENCE_CONFLICT",
  "TRACE_EVENT_TOO_LARGE",
  "TRACE_FORBIDDEN_CONTENT",
  "TRACE_STORE_FAILURE",
  "TRACE_STORE_CORRUPT",
  "TRACE_RECORDER_FAILURE",
] as const;
export type TraceIssueCode = (typeof TRACE_ISSUE_CODES)[number];

/** A redacted Trace Store failure: the message is the code. No path, OS text, or stored content escapes. */
export class TraceStoreError extends Error {
  constructor(readonly code: TraceIssueCode) {
    super(code);
    this.name = "TraceStoreError";
  }
}

export function traceIssueCodeOf(error: unknown): TraceIssueCode {
  return error instanceof TraceStoreError ? error.code : "TRACE_STORE_FAILURE";
}

/**
 * The focused Trace Store port (ADR-020). Deliberately separate from
 * `DurabilityStore`: durability holds execution-correctness state, the Trace
 * Store holds observational evidence. Append-only — there is no update or
 * delete. Events are partitioned by Run and ordered by `sequence`.
 *
 * Semantics shared by every implementation:
 * - an event is validated (schema, size, content policy) before storage;
 * - the same `eventId` with the exact same canonical event is an idempotent
 *   no-op (`"duplicate"`); the same id with different contents is
 *   `TRACE_EVENT_CONFLICT`, and the stored evidence is never overwritten;
 * - sequences are strictly contiguous from 0 per Run (one recorder owns
 *   the sequence); anything else is `TRACE_SEQUENCE_CONFLICT`;
 * - every event of a Run shares one trace id and one workflow identity.
 */
export interface TraceStore {
  append(event: TraceEvent): Promise<"appended" | "duplicate">;
  /** The Run's events in sequence order, validated on load; `[]` when none exist. Corrupt data rejects `TRACE_STORE_CORRUPT`. */
  getRunTrace(runId: string): Promise<TraceEvent[]>;
  getEvent(runId: string, eventId: string): Promise<TraceEvent | undefined>;
  /** The last stored sequence of the Run, or -1. */
  getLastSequence(runId: string): Promise<number>;
}

/**
 * Validated in-memory view of one Run's events: the append decision both
 * stores share, so their semantics cannot drift.
 */
export class TraceRunLog {
  readonly events: TraceEvent[] = [];
  private readonly serializedById = new Map<string, string>();

  /** Builds a log from loaded events, rejecting anything a valid store could not have written. */
  static load(runId: string, raw: readonly unknown[]): TraceRunLog {
    const log = new TraceRunLog();
    raw.forEach((candidate, index) => {
      const checked = checkTraceEvent(candidate);
      if (!checked.ok || checked.event.runId !== runId || checked.event.sequence !== index) throw new TraceStoreError("TRACE_STORE_CORRUPT");
      try { log.decide(checked.event); } catch { throw new TraceStoreError("TRACE_STORE_CORRUPT"); }
      log.commit(checked.event);
    });
    return log;
  }

  /** `"append"`, `"duplicate"`, or throws a conflict. Never mutates. */
  decide(event: TraceEvent): "append" | "duplicate" {
    const existing = this.serializedById.get(event.eventId);
    if (existing !== undefined) {
      if (existing === serializeTraceEvent(event)) return "duplicate";
      throw new TraceStoreError("TRACE_EVENT_CONFLICT");
    }
    const first = this.events[0];
    if (first && (first.traceId !== event.traceId || first.workflowId !== event.workflowId || first.workflowVersion !== event.workflowVersion || first.runId !== event.runId)) throw new TraceStoreError("TRACE_EVENT_CONFLICT");
    if (event.sequence !== this.events.length) throw new TraceStoreError("TRACE_SEQUENCE_CONFLICT");
    return "append";
  }

  commit(event: TraceEvent): void {
    this.events.push(event);
    this.serializedById.set(event.eventId, serializeTraceEvent(event));
  }

  get(eventId: string): TraceEvent | undefined {
    return this.serializedById.has(eventId) ? this.events.find((event) => event.eventId === eventId) : undefined;
  }
}

/** Validates an event for `append`. */
export function validatedForAppend(event: unknown): TraceEvent {
  const checked = checkTraceEvent(event);
  if (!checked.ok) throw new TraceStoreError(checked.code);
  return checked.event;
}

export function assertRunId(runId: unknown): string {
  if (!RunIdSchema.safeParse(runId).success) throw new TraceStoreError("TRACE_INVALID_EVENT");
  return runId as string;
}

export function assertEventId(eventId: unknown): string {
  if (!TraceEventIdSchema.safeParse(eventId).success) throw new TraceStoreError("TRACE_INVALID_EVENT");
  return eventId as string;
}

export function cloneEvent(event: TraceEvent): TraceEvent {
  return deepFreeze(JSON.parse(JSON.stringify(event)) as TraceEvent);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/** Nonpersistent store for unit tests, fixtures, and nondurable local execution. Same semantics as the file store. */
export function createInMemoryTraceStore(): TraceStore {
  const runs = new Map<string, TraceRunLog>();
  return Object.freeze({
    async append(event: TraceEvent) {
      const parsed = validatedForAppend(event);
      const log = runs.get(parsed.runId) ?? new TraceRunLog();
      const decision = log.decide(parsed);
      if (decision === "duplicate") return "duplicate";
      log.commit(cloneEvent(parsed));
      runs.set(parsed.runId, log);
      return "appended";
    },
    async getRunTrace(runId: string) {
      return (runs.get(assertRunId(runId))?.events ?? []).map(cloneEvent);
    },
    async getEvent(runId: string, eventId: string) {
      const event = runs.get(assertRunId(runId))?.get(assertEventId(eventId));
      return event ? cloneEvent(event) : undefined;
    },
    async getLastSequence(runId: string) {
      return (runs.get(assertRunId(runId))?.events.length ?? 0) - 1;
    },
  } satisfies TraceStore);
}
