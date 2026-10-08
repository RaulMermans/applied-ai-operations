import { createHash } from "node:crypto";
import { AUDIT_GENESIS_HASH, AuditEventSchema, MAX_AUDIT_EVENT_BYTES, canonicalJsonStringify, type AuditEvent, type JsonValue } from "@aao/contracts";
import { findForbiddenTraceKeys, isTraceJsonSafe } from "../content-policy.js";

/**
 * Audit event identity, hash chain, and the checks every event passes
 * before storage (ADR-021). Canonicalization reuses the one contracts
 * canonical JSON (`canonicalJsonStringify`: recursively sorted keys, array
 * order kept, no whitespace) shared with Trace and Durability fingerprints.
 */

export { AUDIT_GENESIS_HASH };

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** `aud.` + 32 hex: SHA-256 over stream, type, and the emitter's semantic key. Same logical event → same id, across restarts. */
export function deriveAuditEventId(params: { streamId: string; type: string; key: Record<string, string | number | boolean> }): string {
  return `aud.${sha256(JSON.stringify(["aao.audit-event-id.v1", params.streamId, params.type, canonicalJsonStringify(params.key)])).slice(0, 32)}`;
}

/**
 * `eventHash = SHA-256(canonical JSON of { domain, event-without-eventHash })`.
 * The hashed content includes `previousHash`, `sequence`, and `streamId`,
 * so changing, removing, or reordering any committed event breaks the chain.
 */
export function computeAuditEventHash(event: Omit<AuditEvent, "eventHash"> | Record<string, unknown>): string {
  const { eventHash: _eventHash, ...content } = event as Record<string, unknown>;
  return sha256(canonicalJsonStringify({ domain: "aao.audit-event.v1", event: content as JsonValue }));
}

/** Deterministic serialization of a committed event. */
export function serializeAuditEvent(event: AuditEvent): string {
  return canonicalJsonStringify(event as unknown as JsonValue);
}

export type AuditEventCheck = { ok: true; event: AuditEvent } | { ok: false; code: "AUDIT_INVALID_EVENT" | "AUDIT_EVENT_TOO_LARGE" | "AUDIT_FORBIDDEN_CONTENT" | "AUDIT_HASH_MISMATCH" };

/**
 * Every check a committed event passes: JSON safety, the V1 schema with its
 * typed payload, the size bound (never truncated), the shared exact-key
 * content policy, and its own `eventHash`. Chain linkage is checked by the
 * stream log and the validator.
 */
export function checkAuditEvent(raw: unknown): AuditEventCheck {
  if (!isTraceJsonSafe(raw)) return { ok: false, code: "AUDIT_INVALID_EVENT" };
  const parsed = AuditEventSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, code: "AUDIT_INVALID_EVENT" };
  const event = parsed.data as AuditEvent;
  if (Buffer.byteLength(serializeAuditEvent(event), "utf8") > MAX_AUDIT_EVENT_BYTES) return { ok: false, code: "AUDIT_EVENT_TOO_LARGE" };
  if (findForbiddenTraceKeys(event.payload).length > 0 || findForbiddenTraceKeys(event.target).length > 0) return { ok: false, code: "AUDIT_FORBIDDEN_CONTENT" };
  if (computeAuditEventHash(event) !== event.eventHash) return { ok: false, code: "AUDIT_HASH_MISMATCH" };
  return { ok: true, event };
}
