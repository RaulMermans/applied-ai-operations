import { AUDIT_GENESIS_HASH, AuditEventIdSchema, AuditStreamIdSchema, type AuditEvent } from "@aao/contracts";
import { checkAuditEvent, serializeAuditEvent } from "./event.js";
import { validateAuditStream, type AuditValidationResult } from "./validator.js";

/**
 * Audit-infrastructure issue codes (ADR-021). They describe Audit evidence
 * itself and are never execution failures: no Approval, Tool, or Run
 * outcome changes because any of them occurred, and none triggers a retry.
 */
export const AUDIT_ISSUE_CODES = [
  "AUDIT_INVALID_EVENT",
  "AUDIT_EVENT_TOO_LARGE",
  "AUDIT_FORBIDDEN_CONTENT",
  "AUDIT_EVENT_CONFLICT",
  "AUDIT_SEQUENCE_CONFLICT",
  "AUDIT_HASH_MISMATCH",
  "AUDIT_STORE_FAILURE",
  "AUDIT_STORE_CORRUPT",
  "AUDIT_RECORDER_FAILURE",
] as const;
export type AuditIssueCode = (typeof AUDIT_ISSUE_CODES)[number];

/** A redacted Audit Store failure: the message is the code. No path, OS text, or stored content escapes. */
export class AuditStoreError extends Error {
  constructor(readonly code: AuditIssueCode) {
    super(code);
    this.name = "AuditStoreError";
  }
}

export function auditIssueCodeOf(error: unknown): AuditIssueCode {
  return error instanceof AuditStoreError ? error.code : "AUDIT_STORE_FAILURE";
}

/**
 * The focused Audit Store port (ADR-021) — deliberately separate from
 * `TraceStore` and `DurabilityStore`: different semantics, retention,
 * access, and completeness expectations. Append-only: no update, no delete,
 * no query language, no Run reconstruction.
 *
 * Shared semantics:
 * - an event is validated (schema, size, content policy, its own hash) before storage;
 * - the same `eventId` with the exact same event is an idempotent no-op;
 *   the same id with different content is `AUDIT_EVENT_CONFLICT` and the
 *   stored evidence is never overwritten;
 * - `sequence` is contiguous from 0 per stream and `previousHash` must be the
 *   prior event's `eventHash` (genesis for the first); anything else is
 *   `AUDIT_SEQUENCE_CONFLICT`;
 * - a stream that fails integrity verification on load is
 *   `AUDIT_STORE_CORRUPT` and is never extended or repaired.
 */
export interface AuditStore {
  append(event: AuditEvent): Promise<"appended" | "duplicate">;
  /** The stream's events in sequence order; `[]` when none exist. A stream failing integrity rejects `AUDIT_STORE_CORRUPT`. */
  getStream(streamId: string): Promise<AuditEvent[]>;
  getEvent(streamId: string, eventId: string): Promise<AuditEvent | undefined>;
  /** Full verification (integrity and event order) of the stored stream. Never throws for tampered content: it reports it. */
  verifyStream(streamId: string): Promise<AuditValidationResult>;
}

/** Validated in-memory view of one stream: the append decision both stores share, so their semantics cannot drift. */
export class AuditStreamLog {
  readonly events: AuditEvent[] = [];
  private readonly serializedById = new Map<string, string>();

  /** Builds a log from loaded events, rejecting any stream that fails integrity verification. */
  static load(streamId: string, raw: readonly unknown[]): AuditStreamLog {
    if (!validateAuditStream(raw, { streamId, integrityOnly: true }).valid) throw new AuditStoreError("AUDIT_STORE_CORRUPT");
    const log = new AuditStreamLog();
    for (const candidate of raw) {
      const checked = checkAuditEvent(candidate);
      if (!checked.ok) throw new AuditStoreError("AUDIT_STORE_CORRUPT");
      log.commit(checked.event);
    }
    return log;
  }

  get lastHash(): string {
    return this.events[this.events.length - 1]?.eventHash ?? AUDIT_GENESIS_HASH;
  }

  /** `"append"`, `"duplicate"`, or throws a conflict. Never mutates. */
  decide(event: AuditEvent): "append" | "duplicate" {
    const existing = this.serializedById.get(event.eventId);
    if (existing !== undefined) {
      if (existing === serializeAuditEvent(event)) return "duplicate";
      throw new AuditStoreError("AUDIT_EVENT_CONFLICT");
    }
    const first = this.events[0];
    if (first && (first.streamId !== event.streamId || first.runId !== event.runId)) throw new AuditStoreError("AUDIT_EVENT_CONFLICT");
    if (event.sequence !== this.events.length || event.previousHash !== this.lastHash) throw new AuditStoreError("AUDIT_SEQUENCE_CONFLICT");
    return "append";
  }

  commit(event: AuditEvent): void {
    this.events.push(event);
    this.serializedById.set(event.eventId, serializeAuditEvent(event));
  }

  get(eventId: string): AuditEvent | undefined {
    return this.serializedById.has(eventId) ? this.events.find((event) => event.eventId === eventId) : undefined;
  }
}

export function validatedAuditForAppend(event: unknown): AuditEvent {
  const checked = checkAuditEvent(event);
  if (!checked.ok) throw new AuditStoreError(checked.code);
  return checked.event;
}

export function assertStreamId(streamId: unknown): string {
  if (!AuditStreamIdSchema.safeParse(streamId).success) throw new AuditStoreError("AUDIT_INVALID_EVENT");
  return streamId as string;
}

export function assertAuditEventId(eventId: unknown): string {
  if (!AuditEventIdSchema.safeParse(eventId).success) throw new AuditStoreError("AUDIT_INVALID_EVENT");
  return eventId as string;
}

export function cloneAuditEvent(event: AuditEvent): AuditEvent {
  return deepFreeze(JSON.parse(JSON.stringify(event)) as AuditEvent);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/** Nonpersistent Audit Store for tests and nondurable operation. Same semantics as the file store. */
export function createInMemoryAuditStore(): AuditStore {
  const streams = new Map<string, AuditStreamLog>();
  return Object.freeze({
    async append(event: AuditEvent) {
      const parsed = validatedAuditForAppend(event);
      const log = streams.get(parsed.streamId) ?? new AuditStreamLog();
      if (log.decide(parsed) === "duplicate") return "duplicate" as const;
      log.commit(cloneAuditEvent(parsed));
      streams.set(parsed.streamId, log);
      return "appended" as const;
    },
    async getStream(streamId: string) {
      return (streams.get(assertStreamId(streamId))?.events ?? []).map(cloneAuditEvent);
    },
    async getEvent(streamId: string, eventId: string) {
      const event = streams.get(assertStreamId(streamId))?.get(assertAuditEventId(eventId));
      return event ? cloneAuditEvent(event) : undefined;
    },
    async verifyStream(streamId: string) {
      return validateAuditStream(streams.get(assertStreamId(streamId))?.events ?? [], { streamId });
    },
  } satisfies AuditStore);
}
