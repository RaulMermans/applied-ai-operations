import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_GENESIS_HASH, AuditEventSchema, type AuditEvent, type AuditEventDraft } from "@aao/contracts";
import { AuditStoreError, checkAuditEvent, computeAuditEventHash, createAuditRecorder, createFileAuditStore, createInMemoryAuditStore, createInMemoryTraceStore, validateAuditStream, type AuditStore } from "../src/index.js";
import { tempRoot } from "./fixtures.js";

const runId = "run.audit";
const streamId = `run:${runId}`;
const fingerprint = "a".repeat(64);
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 8, 12, 0, 0) + seconds * 1000).toISOString();

const requested = (approvalId: string, seconds = 0, roles = ["manager"]): AuditEventDraft => ({ type: "approval.requested", runId, actor: { id: "user.alice", type: "user" }, target: { kind: "approval", approvalId }, occurredAt: at(seconds), key: { approvalId }, payload: { approvalId, nodeId: "approval", requiredApproverRoleIds: roles, permissionClasses: ["read_only"], allowSelfApproval: false, requestFingerprint: fingerprint } });
const resolved = (approvalId: string, seconds: number, decision: "approved" | "rejected" = "approved"): AuditEventDraft => ({ type: "approval.resolved", runId, actor: { id: "user.bob", type: "user" }, target: { kind: "approval", approvalId }, occurredAt: at(seconds), key: { approvalId }, payload: { approvalId, nodeId: "approval", decision, requestFingerprint: fingerprint } });
const allowed = (attempt = 1): AuditEventDraft => ({ type: "tool.access.allowed", runId, actor: { id: "user.alice", type: "user" }, target: { kind: "tool", toolId: "local.lookup", toolVersion: "1.0.0" }, key: { toolExecutionId: "tool.1", attempt, decision: "allow" }, payload: { toolExecutionId: "tool.1", attempt, permissionClasses: ["read_only"], agentCeilingApplied: false } });

function clock(start = 100) {
  let tick = start;
  return { now: () => at(tick++) };
}

async function recordThree(store: AuditStore) {
  const recorder = createAuditRecorder({ store, clock: clock() });
  recorder.emit(requested("approval:1", 0));
  recorder.emit(resolved("approval:1", 10));
  recorder.emit(allowed());
  await recorder.flush();
  expect(recorder.health()).toMatchObject({ status: "healthy", appended: 3 });
  return recorder;
}

function eventsDir(root: string): string {
  const [stream] = readdirSync(join(root, "streams"));
  return join(root, "streams", stream!, "events");
}

describe("Audit recorder", () => {
  it("assigns deterministic identity, contiguous sequence, and a SHA-256 hash chain from genesis", async () => {
    const store = createInMemoryAuditStore();
    await recordThree(store);
    const events = await store.getStream(streamId);
    expect(events.map((event) => [event.sequence, event.type, event.outcome])).toEqual([[0, "approval.requested", "requested"], [1, "approval.resolved", "approved"], [2, "tool.access.allowed", "allowed"]]);
    expect(events[0]!.previousHash).toBe(AUDIT_GENESIS_HASH);
    expect(events[1]!.previousHash).toBe(events[0]!.eventHash);
    expect(events[2]!.previousHash).toBe(events[1]!.eventHash);
    for (const event of events) expect(computeAuditEventHash(event)).toBe(event.eventHash);
    // Source time is authoritative; only the Tool access decision takes the recorder's trusted clock.
    expect(events.map((event) => event.occurredAt)).toEqual([at(0), at(10), at(100)]);
    // Same input, fresh store and recorder: identical ids and hashes.
    const again = createInMemoryAuditStore();
    await recordThree(again);
    expect(await again.getStream(streamId)).toEqual(events);
    expect(await store.verifyStream(streamId)).toEqual({ valid: true, issues: [] });
  });

  it("re-emitting the same logical event is one event; same id with different content is AUDIT_EVENT_CONFLICT and nothing is overwritten", async () => {
    const store = createInMemoryAuditStore();
    const recorder = createAuditRecorder({ store, clock: clock() });
    recorder.emit(requested("approval:1", 0));
    recorder.emit(requested("approval:1", 0));
    await recorder.flush();
    expect(await store.getStream(streamId)).toHaveLength(1);
    expect(recorder.health()).toMatchObject({ status: "healthy", appended: 1, deduplicated: 1 });
    recorder.emit(requested("approval:1", 5));
    await recorder.flush();
    expect(recorder.health()).toMatchObject({ status: "degraded", issues: [{ code: "AUDIT_EVENT_CONFLICT", streamId, eventType: "approval.requested" }] });
    expect((await store.getStream(streamId))[0]!.occurredAt).toBe(at(0));
  });

  it("rejects an oversized event without truncating it, and marks Audit degraded", async () => {
    const store = createInMemoryAuditStore();
    const recorder = createAuditRecorder({ store, clock: clock() });
    const roles = Array.from({ length: 64 }, (_, index) => `role.${String(index).padStart(2, "0")}.${"r".repeat(240)}`);
    recorder.emit(requested("approval:big", 0, roles));
    await recorder.flush();
    expect(recorder.health().issues).toEqual([{ code: "AUDIT_EVENT_TOO_LARGE", streamId, eventType: "approval.requested" }]);
    expect(await store.getStream(streamId)).toEqual([]);
  });

  it("an invalid draft (untyped payload content, missing source time) is an issue, never stored", async () => {
    const store = createInMemoryAuditStore();
    const recorder = createAuditRecorder({ store, clock: clock() });
    recorder.emit({ ...allowed(), payload: { ...allowed().payload, input: { secret: "sk-live" } } } as never);
    const { occurredAt: _occurredAt, ...untimed } = resolved("approval:1", 1);
    recorder.emit(untimed as AuditEventDraft);
    await recorder.flush();
    expect(recorder.health().issues.map((issue) => issue.code)).toEqual(["AUDIT_INVALID_EVENT", "AUDIT_INVALID_EVENT"]);
    expect(await store.getStream(streamId)).toEqual([]);
  });

  it("a failing store never throws into the caller: degraded health, bounded code, no raw exception text", async () => {
    const failing: AuditStore = { ...createInMemoryAuditStore(), append: async () => { throw new Error("EACCES /var/secret/audit sk-live-123"); } };
    const recorder = createAuditRecorder({ store: failing, clock: clock() });
    await expect(recorder.emit(resolved("approval:1", 1))).resolves.toBeUndefined();
    const health = recorder.health();
    expect(health).toMatchObject({ status: "degraded", appended: 0, issues: [{ code: "AUDIT_STORE_FAILURE" }] });
    expect(JSON.stringify(health)).not.toMatch(/EACCES|secret|sk-live/);
    expect(recorder.streamHealth(streamId).status).toBe("degraded");
    expect(recorder.streamHealth("run:run.other").status).toBe("healthy");
  });
});

describe("Audit stores", () => {
  it.each([["in-memory", () => createInMemoryAuditStore()], ["file", () => createFileAuditStore({ root: tempRoot("aao-audit-") })]])("%s: append-only, exact replay is a no-op, conflicts and broken links are refused", async (_name, make) => {
    const store = make();
    await recordThree(store);
    const [first, second] = await store.getStream(streamId);
    expect(await store.append(first!)).toBe("duplicate");
    const forged = { ...first!, occurredAt: at(1) };
    await expect(store.append({ ...forged, eventHash: computeAuditEventHash(forged) })).rejects.toMatchObject({ code: "AUDIT_EVENT_CONFLICT" });
    // A new event that skips a sequence or links to the wrong previous hash.
    const next = (await createInMemoryAuditStoreWith(allowed(2))).at(-1)!;
    const gap = { ...next, sequence: 7 };
    await expect(store.append({ ...gap, eventHash: computeAuditEventHash(gap) })).rejects.toMatchObject({ code: "AUDIT_SEQUENCE_CONFLICT" });
    const relinked = { ...next, sequence: 3, previousHash: second!.eventHash };
    await expect(store.append({ ...relinked, eventHash: computeAuditEventHash(relinked) })).rejects.toMatchObject({ code: "AUDIT_SEQUENCE_CONFLICT" });
    await expect(store.append({ ...first!, eventHash: "f".repeat(64) })).rejects.toMatchObject({ code: "AUDIT_HASH_MISMATCH" });
    expect(await store.getStream(streamId)).toHaveLength(3);
    expect(await store.getEvent(streamId, first!.eventId)).toEqual(first);
    expect(await store.verifyStream(streamId)).toEqual({ valid: true, issues: [] });
    // There is no update, delete, query language, or Run reconstruction.
    expect(Object.keys(store).sort()).toEqual(["append", "getEvent", "getStream", "verifyStream"]);
  });

  it("file store: a new process continues the same stream, sequence, and chain without duplicates", async () => {
    const root = tempRoot("aao-audit-");
    const a = createAuditRecorder({ store: createFileAuditStore({ root }), clock: clock() });
    a.emit(requested("approval:1", 0));
    a.emit(resolved("approval:1", 10));
    await a.flush();
    const b = createAuditRecorder({ store: createFileAuditStore({ root }), clock: clock(200) });
    b.emit(resolved("approval:1", 10)); // re-emitted after restart: deduplicated
    b.emit(allowed());
    await b.flush();
    expect(b.health()).toMatchObject({ status: "healthy", appended: 1, deduplicated: 1 });
    const events = await createFileAuditStore({ root }).getStream(streamId);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(3);
    expect(validateAuditStream(events, { streamId })).toEqual({ valid: true, issues: [] });
  });

  it("file store: inspectable hashed layout, one immutable file per event, no temp files left", async () => {
    const root = tempRoot("aao-audit-");
    await recordThree(createFileAuditStore({ root }));
    const [stream] = readdirSync(join(root, "streams"));
    expect(stream).toMatch(/^[a-f0-9]{64}$/);
    expect(readdirSync(eventsDir(root))).toEqual(["000000000.json", "000000001.json", "000000002.json"]);
    const stored = JSON.parse(readFileSync(join(eventsDir(root), "000000001.json"), "utf8")) as AuditEvent;
    expect(AuditEventSchema.parse(stored).type).toBe("approval.resolved");
    expect(lstatSync(join(eventsDir(root), "000000001.json")).mode & 0o777).toBe(0o600);
    // A stray temp file from a crashed write is never evidence.
    writeFileSync(join(eventsDir(root), ".tmp-crashed"), "{partial");
    expect(await createFileAuditStore({ root }).getStream(streamId)).toHaveLength(3);
  });

  it("file store: path safety — caller text never becomes a path and symlinked directories fail closed", async () => {
    const root = tempRoot("aao-audit-");
    const store = createFileAuditStore({ root });
    await expect(store.getStream("run:../../etc")).rejects.toBeInstanceOf(AuditStoreError);
    await expect(store.getStream("system:x")).rejects.toMatchObject({ code: "AUDIT_INVALID_EVENT" });
    const outside = tempRoot("aao-audit-outside-");
    rmSync(join(root, "streams"), { recursive: true });
    symlinkSync(outside, join(root, "streams"));
    expect(() => createFileAuditStore({ root })).toThrow(expect.objectContaining({ code: "AUDIT_STORE_CORRUPT" }));
  });
});

describe("Audit hash chain is tamper-evident", () => {
  async function stored() {
    const root = tempRoot("aao-audit-");
    await recordThree(createFileAuditStore({ root }));
    return { root, dir: eventsDir(root), file: (sequence: number) => join(eventsDir(root), `${String(sequence).padStart(9, "0")}.json`) };
  }
  const codes = async (root: string) => (await createFileAuditStore({ root }).verifyStream(streamId)).issues.map((issue) => `${issue.code}@${issue.index}`);

  it("a modified middle event fails verification, later events are still checked, and the stream is never extended", async () => {
    const { root, file } = await stored();
    const middle = JSON.parse(readFileSync(file(1), "utf8")) as AuditEvent;
    writeFileSync(file(1), JSON.stringify({ ...middle, occurredAt: at(5) }));
    expect(await codes(root)).toEqual(["AUDIT_HASH_MISMATCH@1"]);
    const store = createFileAuditStore({ root });
    await expect(store.getStream(streamId)).rejects.toMatchObject({ code: "AUDIT_STORE_CORRUPT" });
    const recorder = createAuditRecorder({ store, clock: clock() });
    await recorder.emit(allowed(2));
    expect(recorder.health().issues).toEqual([{ code: "AUDIT_STORE_CORRUPT", streamId, eventType: "tool.access.allowed" }]);
    expect(readdirSync(eventsDir(root))).toHaveLength(3);
  });

  it("re-hashing a modified event does not hide it: the next event's previousHash no longer matches", async () => {
    const { root, file } = await stored();
    const middle = JSON.parse(readFileSync(file(1), "utf8")) as AuditEvent;
    const forged = { ...middle, actor: { id: "user.mallory", type: "user" } };
    writeFileSync(file(1), JSON.stringify({ ...forged, eventHash: computeAuditEventHash(forged) }));
    expect(await codes(root)).toEqual(["AUDIT_PREVIOUS_HASH_MISMATCH@2"]);
  });

  it("a removed event breaks sequence and linkage", async () => {
    const { root, file } = await stored();
    unlinkSync(file(1));
    expect(await codes(root)).toEqual(["AUDIT_PREVIOUS_HASH_MISMATCH@1", "AUDIT_SEQUENCE_GAP@1"]);
  });

  it("reordered events break sequence and linkage", async () => {
    const { root, file } = await stored();
    renameSync(file(1), join(eventsDir(root), "tmp.json"));
    renameSync(file(2), file(1));
    renameSync(join(eventsDir(root), "tmp.json"), file(2));
    const issues = await codes(root);
    expect(issues).toContain("AUDIT_SEQUENCE_GAP@1");
    expect(issues).toContain("AUDIT_PREVIOUS_HASH_MISMATCH@1");
    expect(issues).toContain("AUDIT_PREVIOUS_HASH_MISMATCH@2");
  });

  it("a wrong previousHash is reported even when the event's own hash is consistent", async () => {
    const { root, file } = await stored();
    const last = JSON.parse(readFileSync(file(2), "utf8")) as AuditEvent;
    const relinked = { ...last, previousHash: "e".repeat(64) };
    writeFileSync(file(2), JSON.stringify({ ...relinked, eventHash: computeAuditEventHash(relinked) }));
    expect(await codes(root)).toEqual(["AUDIT_PREVIOUS_HASH_MISMATCH@2"]);
  });

  it("garbage content is reported at its position, not silently skipped", async () => {
    const { root, file } = await stored();
    writeFileSync(file(1), "{not json");
    expect(await codes(root)).toEqual(["AUDIT_INVALID_EVENT@1", "AUDIT_PREVIOUS_HASH_MISMATCH@1", "AUDIT_SEQUENCE_GAP@1", "AUDIT_PREVIOUS_HASH_MISMATCH@2"]);
  });

  it("event-order invariants reveal missing evidence: a resolution without its recorded request", async () => {
    const store = createInMemoryAuditStore();
    const recorder = createAuditRecorder({ store, clock: clock() });
    recorder.emit(resolved("approval:1", 10));
    await recorder.flush();
    expect(await store.verifyStream(streamId)).toEqual({ valid: false, issues: [{ code: "AUDIT_EVENT_ORDER_VIOLATION", index: 0 }] });
    // Integrity alone still holds, so the store keeps accepting evidence.
    expect(validateAuditStream(await store.getStream(streamId), { integrityOnly: true }).valid).toBe(true);
  });

  it("checkAuditEvent verifies each event's own hash", async () => {
    const store = createInMemoryAuditStore();
    await recordThree(store);
    const [event] = await store.getStream(streamId);
    expect(checkAuditEvent(event).ok).toBe(true);
    expect(checkAuditEvent({ ...event!, outcome: "requested", payload: { ...event!.payload } })).toEqual({ ok: true, event });
    expect(checkAuditEvent({ ...event!, sequence: 0, runId: "run.audit", payload: { ...event!.payload, allowSelfApproval: true } })).toEqual({ ok: false, code: "AUDIT_HASH_MISMATCH" });
  });
});

describe("Audit and Trace are separate stores", () => {
  it("AuditStore has no Trace API and TraceStore has no Audit API", () => {
    expect(Object.keys(createInMemoryAuditStore()).sort()).toEqual(["append", "getEvent", "getStream", "verifyStream"]);
    expect(Object.keys(createInMemoryTraceStore()).sort()).toEqual(["append", "getEvent", "getLastSequence", "getRunTrace"]);
  });

  it("a deleted audit root starts a fresh, valid chain rather than inheriting anything", async () => {
    const root = tempRoot("aao-audit-");
    await recordThree(createFileAuditStore({ root }));
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root);
    expect(existsSync(join(root, "streams"))).toBe(false);
    expect(await createFileAuditStore({ root }).getStream(streamId)).toEqual([]);
  });
});

async function createInMemoryAuditStoreWith(...drafts: AuditEventDraft[]): Promise<AuditEvent[]> {
  const store = createInMemoryAuditStore();
  const recorder = createAuditRecorder({ store, clock: clock() });
  for (const draft of [requested("approval:1", 0), resolved("approval:1", 10), allowed(), ...drafts]) recorder.emit(draft);
  await recorder.flush();
  return store.getStream(streamId);
}
