import { mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_TRACE_EVENT_BYTES, type TraceEvent, type TraceEventDraft } from "@aao/contracts";
import { TraceStoreError, createFileTraceStore, createInMemoryTraceStore, createTraceRecorder, deriveEventId, deriveSpanId, deriveTraceId, findForbiddenTraceKeys, reliabilityPolicyFingerprint, validateTrace, type TraceStore } from "../src/index.js";
import { clockAt, tempRoot } from "./fixtures.js";

const identity = { runId: "run.store", workflowId: "wf.store", workflowVersion: "1.0.0" };
const traceId = deriveTraceId(identity.runId, identity.workflowId, identity.workflowVersion);

function event(sequence: number, overrides: Partial<TraceEvent> = {}): TraceEvent {
  const span = { kind: "run" as const };
  return {
    schemaVersion: 2,
    eventId: deriveEventId({ traceId, type: "route.selected", span, key: { step: sequence } }),
    traceId,
    ...identity,
    sequence,
    occurredAt: "2026-10-08T12:00:00.000Z",
    type: "route.selected",
    spanId: deriveSpanId(traceId, span),
    payload: { sourceNodeId: "a", targetNodeId: "b", routeType: "unconditional" },
    ...overrides,
  } as TraceEvent;
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try { await promise; return "resolved"; } catch (error) { return error instanceof TraceStoreError ? error.code : `raw:${String(error)}`; }
}

describe("trace identity", () => {
  it("derives a stable, OTel-width trace id from trusted Run + workflow identity", () => {
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(deriveTraceId("run.store", "wf.store", "1.0.0")).toBe(traceId);
    expect(deriveTraceId("run.other", "wf.store", "1.0.0")).not.toBe(traceId);
    expect(deriveTraceId("run.store", "wf.store", "2.0.0")).not.toBe(traceId);
  });

  it("derives span ids from semantic span identity: same logical operation → same span, different attempt → different span", () => {
    const tool = (attempt: number) => deriveSpanId(traceId, { kind: "tool", toolExecutionId: "tool.x", attempt });
    expect(tool(1)).toMatch(/^[a-f0-9]{16}$/);
    expect(tool(1)).toBe(tool(1));
    expect(tool(2)).not.toBe(tool(1));
    expect(deriveSpanId(traceId, { kind: "node", nodeId: "n", step: 1, attempt: 1 })).not.toBe(deriveSpanId(traceId, { kind: "node", nodeId: "n", step: 2, attempt: 1 }));
  });

  it("derives event ids from type, Node, span, and key — insensitive to key order", () => {
    const span = { kind: "node" as const, nodeId: "n", step: 1, attempt: 1 };
    const a = deriveEventId({ traceId, type: "node.started", nodeId: "n", span, key: { step: 1, attempt: 1 } });
    expect(a).toBe(deriveEventId({ traceId, type: "node.started", nodeId: "n", span, key: { attempt: 1, step: 1 } }));
    expect(a).not.toBe(deriveEventId({ traceId, type: "node.started", nodeId: "n", span, key: { step: 1, attempt: 1, replay: true } }));
    expect(a).not.toBe(deriveEventId({ traceId, type: "node.completed", nodeId: "n", span, key: { step: 1, attempt: 1 } }));
  });

  it("fingerprints the reliability configuration deterministically and order-independently", () => {
    const one = reliabilityPolicyFingerprint([{ nodeId: "a", maxAttempts: 2 }, { nodeId: "b", maxAttempts: 3, attemptTimeoutMs: 100 }]);
    expect(one).toBe(reliabilityPolicyFingerprint([{ nodeId: "b", maxAttempts: 3, attemptTimeoutMs: 100 }, { nodeId: "a", maxAttempts: 2 }]));
    expect(one).not.toBe(reliabilityPolicyFingerprint([{ nodeId: "a", maxAttempts: 3 }, { nodeId: "b", maxAttempts: 3, attemptTimeoutMs: 100 }]));
    expect(reliabilityPolicyFingerprint([])).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("content policy", () => {
  it("rejects forbidden content keys exactly, without rejecting safe token-count metadata", () => {
    expect(findForbiddenTraceKeys({ usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, outputKind: "text", requiredCapabilityIds: [] })).toEqual([]);
    expect(findForbiddenTraceKeys({ result: "success" })).toEqual([]);
    expect(findForbiddenTraceKeys({ nested: { api_key: "x", Authorization: "y", messages: [], rawOutput: 1, privateKey: 1, Cookie: 1, prompt: 1, rawInput: 1, password: 1, secret: 1, token: 1 } }).sort()).toEqual(
      ["nested.Authorization", "nested.Cookie", "nested.api_key", "nested.messages", "nested.password", "nested.privateKey", "nested.prompt", "nested.rawInput", "nested.rawOutput", "nested.secret", "nested.token"].sort(),
    );
    expect(findForbiddenTraceKeys({ result: { ok: true } })).toEqual(["result"]);
  });
});

const stores: Array<[string, () => TraceStore]> = [
  ["in-memory", () => createInMemoryTraceStore()],
  ["file", () => createFileTraceStore({ root: tempRoot() })],
];

describe.each(stores)("%s TraceStore semantics", (_name, make) => {
  it("appends in contiguous sequence and returns the ordered Run trace", async () => {
    const store = make();
    expect(await store.getLastSequence(identity.runId)).toBe(-1);
    expect(await store.getRunTrace(identity.runId)).toEqual([]);
    for (const sequence of [0, 1, 2]) expect(await store.append(event(sequence))).toBe("appended");
    expect((await store.getRunTrace(identity.runId)).map((stored) => stored.sequence)).toEqual([0, 1, 2]);
    expect(await store.getLastSequence(identity.runId)).toBe(2);
    expect(await store.getEvent(identity.runId, event(1).eventId)).toEqual(event(1));
    expect(await store.getEvent(identity.runId, "evt.00000000000000000000000000000000")).toBeUndefined();
  });

  it("exact replay of an event is an idempotent no-op; the same id with different content is a conflict and never overwrites", async () => {
    const store = make();
    await store.append(event(0));
    expect(await store.append(event(0))).toBe("duplicate");
    expect(await rejection(store.append(event(0, { occurredAt: "2026-10-08T13:00:00.000Z" })))).toBe("TRACE_EVENT_CONFLICT");
    expect(await rejection(store.append({ ...event(1), eventId: event(0).eventId }))).toBe("TRACE_EVENT_CONFLICT");
    expect(await store.getRunTrace(identity.runId)).toEqual([event(0)]);
  });

  it("rejects sequence gaps, sequence reuse, and identity drift", async () => {
    const store = make();
    await store.append(event(0));
    expect(await rejection(store.append(event(2)))).toBe("TRACE_SEQUENCE_CONFLICT");
    expect(await rejection(store.append({ ...event(1), sequence: 0 }))).toBe("TRACE_SEQUENCE_CONFLICT");
    expect(await rejection(store.append(event(1, { workflowVersion: "9.9.9" })))).toBe("TRACE_EVENT_CONFLICT");
    expect(await rejection(store.append(event(1, { traceId: "f".repeat(32) })))).toBe("TRACE_EVENT_CONFLICT");
    expect(await store.getLastSequence(identity.runId)).toBe(0);
  });

  it("validates before storage: schema, untyped payloads, forbidden content, and size", async () => {
    const store = make();
    expect(await rejection(store.append({ ...event(0), payload: { sourceNodeId: "a" } }))).toBe("TRACE_INVALID_EVENT");
    expect(await rejection(store.append({ ...event(0), type: "custom.thing" } as never))).toBe("TRACE_INVALID_EVENT");
    expect(await rejection(store.append({ ...event(0), occurredAt: new Date() } as never))).toBe("TRACE_INVALID_EVENT");
    const huge = { ...event(0), type: "state.updated", payload: { step: 1, revisionBefore: 0, revisionAfter: 1, changedKeys: Array.from({ length: 512 }, (_, i) => `k${i}${"x".repeat(80)}`) } } as TraceEvent;
    expect(JSON.stringify(huge).length).toBeGreaterThan(MAX_TRACE_EVENT_BYTES);
    expect(await rejection(store.append(huge))).toBe("TRACE_EVENT_TOO_LARGE");
    expect(await store.getRunTrace(identity.runId)).toEqual([]);
  });

  it("is append-only: the port exposes no update or delete", () => {
    expect(Object.keys(make()).sort()).toEqual(["append", "getEvent", "getLastSequence", "getRunTrace"]);
  });
});

describe("file TraceStore persistence and safety", () => {
  it("survives new store construction (a new process) and continues the sequence", async () => {
    const root = tempRoot();
    await createFileTraceStore({ root }).append(event(0));
    const reopened = createFileTraceStore({ root });
    expect(await reopened.getRunTrace(identity.runId)).toEqual([event(0)]);
    expect(await reopened.append(event(1))).toBe("appended");
    expect(await createFileTraceStore({ root }).getLastSequence(identity.runId)).toBe(1);
  });

  it("uses one immutable file per event under a hashed Run directory; temp files are never trace data", async () => {
    const root = tempRoot();
    const store = createFileTraceStore({ root });
    await store.append(event(0));
    const [runDir] = readdirSync(join(root, "runs"));
    expect(runDir).toMatch(/^[a-f0-9]{64}$/);
    const eventsDir = join(root, "runs", runDir!, "events");
    expect(readdirSync(eventsDir)).toEqual(["000000000.json"]);
    writeFileSync(join(eventsDir, ".tmp-partial"), "{\"schemaVersion\": 2, \"eventId\": ");
    expect(await createFileTraceStore({ root }).getRunTrace(identity.runId)).toEqual([event(0)]);
  });

  it("reports corrupt, gapped, or foreign data as TRACE_STORE_CORRUPT without repairing it", async () => {
    const root = tempRoot();
    await createFileTraceStore({ root }).append(event(0));
    const eventsDir = join(root, "runs", readdirSync(join(root, "runs"))[0]!, "events");
    writeFileSync(join(eventsDir, "000000002.json"), JSON.stringify(event(2)));
    expect(await rejection(createFileTraceStore({ root }).getRunTrace(identity.runId))).toBe("TRACE_STORE_CORRUPT");
    rmSync(join(eventsDir, "000000002.json"));
    writeFileSync(join(eventsDir, "000000001.json"), "{not json");
    expect(await rejection(createFileTraceStore({ root }).getRunTrace(identity.runId))).toBe("TRACE_STORE_CORRUPT");
    writeFileSync(join(eventsDir, "000000001.json"), JSON.stringify({ ...event(1), runId: "run.foreign" }));
    expect(await rejection(createFileTraceStore({ root }).getRunTrace(identity.runId))).toBe("TRACE_STORE_CORRUPT");
  });

  it("cannot leave its root: identifiers never become paths, and symlinked directories fail closed", async () => {
    const root = tempRoot();
    const store = createFileTraceStore({ root });
    expect(await rejection(store.getRunTrace("../../etc"))).toBe("TRACE_INVALID_EVENT");
    expect(await rejection(store.append({ ...event(0), runId: "../escape" }))).toBe("TRACE_INVALID_EVENT");
    await store.append(event(0));
    const outside = tempRoot("aao-trace-outside-");
    const runDir = join(root, "runs", readdirSync(join(root, "runs"))[0]!);
    rmSync(join(runDir, "events"), { recursive: true });
    mkdirSync(join(outside, "events"));
    symlinkSync(join(outside, "events"), join(runDir, "events"));
    expect(await rejection(createFileTraceStore({ root }).getRunTrace(identity.runId))).toBe("TRACE_STORE_CORRUPT");
    expect(readdirSync(join(outside, "events"))).toEqual([]);
  });
});

const draft = (type: "route.selected", step: number): TraceEventDraft => ({ type, ...identity, span: { kind: "run" }, key: { step }, payload: { sourceNodeId: "a", targetNodeId: "b", routeType: "unconditional" } });
const started: TraceEventDraft = { type: "run.started", ...identity, span: { kind: "run" }, key: {}, payload: { entryNodeId: "a", initialStateRevision: 0, nodeCount: 2, reliabilityPolicies: [{ nodeId: "a", maxAttempts: 2 }] } };

describe("trace recorder", () => {
  it("assigns identity, contiguous sequence, recorder-derived run.started fields, and host release metadata", async () => {
    const store = createInMemoryTraceStore();
    const recorder = createTraceRecorder({ store, clock: clockAt(0), release: { releaseId: "rel-15", gitSha: "224cadb", environment: "local" } });
    await recorder.emit(started);
    await recorder.emit(draft("route.selected", 1));
    const events = await store.getRunTrace(identity.runId);
    expect(events.map((stored) => [stored.sequence, stored.type, stored.traceId])).toEqual([[0, "run.started", traceId], [1, "route.selected", traceId]]);
    expect(events[0]!.payload).toMatchObject({ reliabilityPolicyFingerprint: reliabilityPolicyFingerprint([{ nodeId: "a", maxAttempts: 2 }]), release: { releaseId: "rel-15", gitSha: "224cadb", environment: "local" } });
    expect(events[0]!.status).toBe("started");
    expect(events[1]!.status).toBeUndefined();
    expect(recorder.health()).toEqual({ status: "healthy", appended: 2, deduplicated: 0, issueCount: 0, issues: [] });
  });

  it("continues the sequence from the store after a restart and deduplicates re-emitted logical events", async () => {
    const root = tempRoot();
    const first = createTraceRecorder({ store: createFileTraceStore({ root }), clock: clockAt(0) });
    await first.emit(started);
    await first.emit(draft("route.selected", 1));
    const second = createTraceRecorder({ store: createFileTraceStore({ root }), clock: clockAt(50) });
    await second.emit(draft("route.selected", 1)); // the same semantic event, re-emitted by a new process
    await second.emit(draft("route.selected", 2));
    const events = await createFileTraceStore({ root }).getRunTrace(identity.runId);
    expect(events.map((stored) => stored.sequence)).toEqual([0, 1, 2]);
    expect(events.filter((stored) => stored.type === "route.selected")).toHaveLength(2);
    expect(second.health()).toMatchObject({ status: "healthy", appended: 1, deduplicated: 1 });
  });

  it("a reused event id with different logical content is a conflict issue; stored evidence is kept", async () => {
    const store = createInMemoryTraceStore();
    const recorder = createTraceRecorder({ store, clock: clockAt(0) });
    await recorder.emit(draft("route.selected", 1));
    await recorder.emit({ ...draft("route.selected", 1), payload: { sourceNodeId: "a", targetNodeId: "c", routeType: "unconditional" } } as TraceEventDraft);
    expect((await store.getRunTrace(identity.runId)).map((stored) => stored.payload.targetNodeId)).toEqual(["b"]);
    expect(recorder.health().issues).toEqual([{ code: "TRACE_EVENT_CONFLICT", runId: identity.runId, eventType: "route.selected" }]);
  });

  it("floors descriptive time at the Run's last event when a restarted machine's clock moves backwards", async () => {
    const root = tempRoot();
    await createTraceRecorder({ store: createFileTraceStore({ root }), clock: clockAt(100) }).emit(started);
    await createTraceRecorder({ store: createFileTraceStore({ root }), clock: clockAt(0) }).emit(draft("route.selected", 1));
    const [a, b] = await createFileTraceStore({ root }).getRunTrace(identity.runId);
    expect(b!.occurredAt).toBe(a!.occurredAt);
    expect(b!.sequence).toBe(1);
  });

  it("never throws: invalid drafts, failing stores, and corrupt stores become bounded issues", async () => {
    const failing: TraceStore = { ...createInMemoryTraceStore(), append: async () => { throw new Error("ENOSPC /var/secret"); } };
    const recorder = createTraceRecorder({ store: failing, clock: clockAt(0) });
    await expect(recorder.emit(draft("route.selected", 1))).resolves.toBeUndefined();
    await expect(recorder.emit({ ...draft("route.selected", 1), payload: { prompt: "hello" } } as never)).resolves.toBeUndefined();
    await expect(recorder.emit(null as never)).resolves.toBeUndefined();
    const corrupt: TraceStore = { ...createInMemoryTraceStore(), getRunTrace: async () => { throw new TraceStoreError("TRACE_STORE_CORRUPT"); } };
    const second = createTraceRecorder({ store: corrupt, clock: clockAt(0) });
    await second.emit(draft("route.selected", 1));
    expect(recorder.health().issues.map((issue) => issue.code)).toEqual(["TRACE_STORE_FAILURE", "TRACE_INVALID_EVENT", "TRACE_INVALID_EVENT"]);
    expect(JSON.stringify(recorder.health())).not.toContain("secret");
    expect(second.health().issues).toEqual([{ code: "TRACE_STORE_CORRUPT", runId: identity.runId, eventType: "route.selected" }]);
  });

  it("bounds recorded issues while still counting all of them", async () => {
    const recorder = createTraceRecorder({ store: { ...createInMemoryTraceStore(), append: async () => { throw new Error("x"); } }, clock: clockAt(0) });
    for (let i = 0; i < 100; i += 1) await recorder.emit(draft("route.selected", i + 1));
    expect(recorder.health().issueCount).toBe(100);
    expect(recorder.health().issues).toHaveLength(64);
  });
});

describe("validateTrace diagnostics", () => {
  it("reports stable codes for broken traces and never mutates input", () => {
    const events = [event(0), event(1)];
    const frozen = JSON.stringify(events);
    expect(validateTrace(events).issues.map((issue) => issue.code)).toContain("TRACE_RUN_START_MISSING");
    expect(validateTrace([]).issues.map((issue) => issue.code)).toEqual(["TRACE_RUN_START_MISSING"]);
    expect(validateTrace([event(0), event(2)]).issues.map((issue) => issue.code)).toContain("TRACE_SEQUENCE_GAP");
    expect(validateTrace([event(0), { ...event(1), eventId: event(0).eventId }]).issues.map((issue) => issue.code)).toContain("TRACE_DUPLICATE_EVENT");
    expect(validateTrace([event(0), { ...event(1), traceId: "a".repeat(32) }]).issues.map((issue) => issue.code)).toContain("TRACE_IDENTITY_MISMATCH");
    expect(validateTrace([{ junk: true }]).issues.map((issue) => issue.code)).toContain("TRACE_INVALID_EVENT");
    expect(validateTrace(events, { runStatus: "COMPLETED" }).issues.map((issue) => issue.code)).toContain("TRACE_TERMINAL_EVENT_MISSING");
    expect(JSON.stringify(events)).toBe(frozen);
  });
});
