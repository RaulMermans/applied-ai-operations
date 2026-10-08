import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalRecordSchema } from "@aao/contracts";
import { createFileDurabilityStore, type DurableCheckpoint, type DurableOperation, type RunManifest } from "../src/index.js";
import { approvalYaml, clockAt, createEffects, initial, tempRoot, world } from "./fixtures.js";

/** A real manifest + checkpoint 0, produced by the host itself, to exercise the store directly. */
async function seededRun(root: string, runId = "run.store") {
  const effects = createEffects();
  const w = world({ root, effects, clock: clockAt(0) });
  const waiting = await w.host.execute({ runId, initialState: initial(runId) });
  if (!waiting.ok) throw new Error("seed run did not reach its wait");
  const runDir = join(root, "runs", readdirSync(join(root, "runs")).find((name) => !name.startsWith(".tmp-"))!);
  return { w, runId, runDir, manifest: (await w.store.getRun(runId))!, latest: (await w.store.getLatestCheckpoint(runId))! };
}

async function rejectionCode(promise: Promise<unknown>): Promise<string | undefined> {
  try { await promise; return undefined; } catch (error) { return (error as { code?: string }).code; }
}

describe("local filesystem DurabilityStore", () => {
  it("creates a Run atomically and reloads it, checkpoint chain intact, from a new store instance", async () => {
    const root = tempRoot();
    const { runId, runDir, manifest, latest } = await seededRun(root);
    expect(manifest).toMatchObject({ schemaVersion: 1, runId, workflowId: "durable.approval", workflowVersion: "1.0.0" });
    expect(readdirSync(join(runDir, "checkpoints"))).toEqual(["000000.json", "000001.json", "000002.json"]);
    const reopened = createFileDurabilityStore({ root });
    expect(await reopened.getRun(runId)).toEqual(manifest);
    expect(await reopened.getLatestCheckpoint(runId)).toEqual(latest);
    expect(latest.sequence).toBe(2);
    expect(latest.executionSnapshot.run.status).toBe("WAITING_FOR_APPROVAL");
    // No caller-supplied identifier becomes a path: the run directory is a SHA-256 key.
    expect(readdirSync(join(root, "runs"))).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
  });

  it("rejects a duplicate Run without touching the existing one", async () => {
    const root = tempRoot();
    const { w, manifest, runId } = await seededRun(root);
    const first = (await w.store.getLatestCheckpoint(runId))!;
    const zero = { ...first, sequence: 0, checkpointId: "checkpoint.000000" } as DurableCheckpoint;
    expect(await rejectionCode(w.store.createRun(manifest, zero))).toBe("DURABLE_RUN_ALREADY_EXISTS");
    expect(await w.store.getLatestCheckpoint(runId)).toEqual(first);
  });

  it("keeps checkpoint sequences strictly monotonic, immutable, and never duplicated", async () => {
    const root = tempRoot();
    const { w, runId, runDir, latest } = await seededRun(root);
    const before = readFileSync(join(runDir, "checkpoints", "000002.json"), "utf8");
    const at = (sequence: number) => ({ ...latest, sequence, checkpointId: `checkpoint.${String(sequence).padStart(6, "0")}` });
    expect(await rejectionCode(w.store.writeCheckpoint(at(2)))).toBe("DURABILITY_CONFLICT");
    expect(await rejectionCode(w.store.writeCheckpoint(at(5)))).toBe("DURABILITY_CONFLICT");
    expect(readFileSync(join(runDir, "checkpoints", "000002.json"), "utf8")).toBe(before);
    await w.store.writeCheckpoint(at(3));
    expect((await w.store.getLatestCheckpoint(runId))!.sequence).toBe(3);
    // Two competing writers of sequence 4: exactly one wins.
    const results = await Promise.allSettled([w.store.writeCheckpoint(at(4)), w.store.writeCheckpoint(at(4))]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  it.each([
    ["malformed JSON", (raw: string) => raw.slice(0, raw.length / 2)],
    ["structurally invalid checkpoint", (raw: string) => JSON.stringify({ ...JSON.parse(raw), executionSnapshot: { schemaVersion: 2 } })],
    ["wrong run id", (raw: string) => JSON.stringify({ ...JSON.parse(raw), runId: "run.other" })],
    ["wrong plan fingerprint", (raw: string) => JSON.stringify({ ...JSON.parse(raw), planFingerprint: "f".repeat(64) })],
    ["sequence that disagrees with its file", (raw: string) => JSON.stringify({ ...JSON.parse(raw), sequence: 7, checkpointId: "checkpoint.000007" })],
    ["unknown extra field", (raw: string) => JSON.stringify({ ...JSON.parse(raw), durable: true })],
  ])("fails closed on a corrupt checkpoint: %s", async (_name, corrupt) => {
    const root = tempRoot();
    const { runId, runDir } = await seededRun(root);
    const path = join(runDir, "checkpoints", "000001.json");
    writeFileSync(path, corrupt(readFileSync(path, "utf8")));
    const store = createFileDurabilityStore({ root });
    expect(await rejectionCode(store.getLatestCheckpoint(runId))).toBe("DURABILITY_CORRUPT_STATE");
  });

  it("fails closed on a gap in the checkpoint chain instead of falling back to an older checkpoint", async () => {
    const root = tempRoot();
    const { runId, runDir } = await seededRun(root);
    rmSync(join(runDir, "checkpoints", "000001.json"));
    expect(await rejectionCode(createFileDurabilityStore({ root }).getLatestCheckpoint(runId))).toBe("DURABILITY_CORRUPT_STATE");
  });

  it("ignores incomplete temp files: they never become authoritative", async () => {
    const root = tempRoot();
    const { runId, runDir, latest } = await seededRun(root);
    writeFileSync(join(runDir, "checkpoints", ".tmp-crashed-write"), "{\"partial\":");
    writeFileSync(join(runDir, "operations", ".tmp-crashed-write"), "{");
    mkdirSync(join(root, "runs", ".tmp-run-crashed"));
    const store = createFileDurabilityStore({ root });
    expect(await store.getLatestCheckpoint(runId)).toEqual(latest);
    expect((await store.getOperationsForRun(runId)).length).toBe(2);
  });

  it("rejects path-traversal identifiers and symlinked store directories", async () => {
    const root = tempRoot();
    const store = createFileDurabilityStore({ root });
    for (const runId of ["../escape", "..", "a/b", "/etc/passwd", ""]) {
      expect(await rejectionCode(store.getRun(runId))).toBe("DURABILITY_INVALID_INPUT");
    }
    expect(() => store.approvals.get("../../escape")).toThrow("DURABILITY_INVALID_INPUT");
    const { runId, runDir } = await seededRun(root, "run.symlink");
    const outside = tempRoot();
    rmSync(join(runDir, "checkpoints"), { recursive: true });
    symlinkSync(outside, join(runDir, "checkpoints"));
    expect(await rejectionCode(createFileDurabilityStore({ root }).getLatestCheckpoint(runId))).toBe("DURABILITY_CORRUPT_STATE");
    const linkedRoot = tempRoot();
    mkdirSync(join(linkedRoot, "elsewhere"));
    symlinkSync(join(linkedRoot, "elsewhere"), join(linkedRoot, "runs"));
    expect(() => createFileDurabilityStore({ root: linkedRoot })).toThrow("DURABILITY_CORRUPT_STATE");
  });

  it("redacts filesystem failures: no path or OS message escapes", async () => {
    const root = tempRoot();
    const { runId, runDir } = await seededRun(root);
    writeFileSync(join(runDir, "checkpoints", "000001.json"), "not json");
    const error = (await createFileDurabilityStore({ root }).getLatestCheckpoint(runId).then(() => new Error("expected a rejection"), (caught: unknown) => caught)) as Error;
    expect(error.message).toBe("DURABILITY_CORRUPT_STATE");
    expect(String(error.stack ?? "")).not.toContain(root);
  });

  it("enforces the operation ledger: create-if-absent intent, one outcome, bounded replay marks, validated outcomes only", async () => {
    const root = tempRoot();
    const { w, runId } = await seededRun(root);
    const operations = await w.store.getOperationsForRun(runId);
    expect(operations.map((operation) => [operation.operationId, operation.nodeId, operation.status, operation.outcome?.kind])).toEqual([
      ["op.s1.a1", "prepare", "OUTCOME_RECORDED", "success"],
      ["op.s2.a1", "approval", "OUTCOME_RECORDED", "wait"],
    ]);
    const intent: DurableOperation = { schemaVersion: 1, operationId: "op.s3.a1", runId, nodeId: "draft", kind: "tool", step: 3, stateRevision: 1, attempt: 1, maxAttempts: 1, recoveryReplayCount: 0, status: "STARTED", startedAt: "2026-10-08T13:00:00.000Z" };
    await w.store.beginOperation(intent);
    expect(await rejectionCode(w.store.beginOperation(intent))).toBe("DURABILITY_CONFLICT");
    await w.store.markOperationReplay(runId, "op.s3.a1", 0);
    expect(await rejectionCode(w.store.markOperationReplay(runId, "op.s3.a1", 0))).toBe("DURABILITY_CONFLICT");
    expect(await rejectionCode(w.store.markOperationReplay(runId, "op.s3.a1", 1))).toBe("DURABILITY_CONFLICT");
    // A raw executor/provider response is not a validated outcome.
    expect(await rejectionCode(w.store.recordOperationOutcome(runId, "op.s3.a1", { ok: true, output: {}, stack: "Error at /x" } as never, "2026-10-08T13:00:01.000Z"))).toBe("DURABILITY_INVALID_INPUT");
    await w.store.recordOperationOutcome(runId, "op.s3.a1", { kind: "success", statePatch: { x: 1 } }, "2026-10-08T13:00:01.000Z");
    expect(await rejectionCode(w.store.recordOperationOutcome(runId, "op.s3.a1", { kind: "success" }, "2026-10-08T13:00:02.000Z"))).toBe("DURABILITY_CONFLICT");
    const reloaded = await createFileDurabilityStore({ root }).getOperationsForRun(runId);
    expect(reloaded.at(-1)).toMatchObject({ status: "OUTCOME_RECORDED", recoveryReplayCount: 1, outcome: { kind: "success", statePatch: { x: 1 } } });
  });

  it("persists idempotent cancellation requests", async () => {
    const root = tempRoot();
    const { w, runId } = await seededRun(root);
    const first = await w.store.requestCancellation(runId, "2026-10-08T13:00:00.000Z");
    expect(await w.store.requestCancellation(runId, "2026-10-08T14:00:00.000Z")).toEqual(first);
    expect(await createFileDurabilityStore({ root }).getCancellation(runId)).toEqual(first);
    expect(await rejectionCode(w.store.requestCancellation("run.unknown", "2026-10-08T13:00:00.000Z"))).toBe("DURABLE_RUN_NOT_FOUND");
  });

  it("stores approvals durably with compare-and-set resolution and no overwrite on create", async () => {
    const root = tempRoot();
    const { w } = await seededRun(root);
    const [approvalFile] = readdirSync(join(root, "approvals"));
    const pending = ApprovalRecordSchema.parse(JSON.parse(readFileSync(join(root, "approvals", approvalFile!), "utf8")));
    const a = createFileDurabilityStore({ root }).approvals;
    const b = createFileDurabilityStore({ root }).approvals;
    expect(a.get(pending.approvalId)).toEqual(pending);
    expect(Object.isFrozen(a.get(pending.approvalId))).toBe(true);
    expect(a.create({ ...pending, requestedAt: "2026-10-09T00:00:00.000Z" })).toEqual(pending);
    const approved = { ...pending, status: "approved" as const, resolvedAt: "2026-10-08T13:00:00.000Z", resolvedBy: { id: "user.bob", type: "user" as const } };
    const rejected = { ...pending, status: "rejected" as const, resolvedAt: "2026-10-08T13:00:00.000Z", resolvedBy: { id: "user.bob", type: "user" as const } };
    expect(a.compareAndSetResolution(pending.approvalId, approved)).toBe(true);
    expect(b.compareAndSetResolution(pending.approvalId, rejected)).toBe(false);
    expect(w.approvals.getApproval(pending.approvalId)?.status).toBe("approved");
    writeFileSync(join(root, "approvals", approvalFile!), JSON.stringify({ ...approved, runId: 7 }));
    expect(() => a.get(pending.approvalId)).toThrow("DURABILITY_CORRUPT_STATE");
  });

  it("never persists functions, class instances, or invalid manifests", async () => {
    const root = tempRoot();
    const store = createFileDurabilityStore({ root });
    const manifest = { schemaVersion: 1, runId: "run.bad", workflowId: "w", workflowVersion: "1", planFingerprint: "a".repeat(64), createdAt: "2026-10-08T12:00:00.000Z" } as RunManifest;
    expect(await rejectionCode(store.createRun({ ...manifest, toJSON: () => ({}) } as never, {} as never))).toBe("DURABILITY_INVALID_INPUT");
    expect(await rejectionCode(store.createRun(manifest, { createdAt: new Date() } as never))).toBe("DURABILITY_INVALID_INPUT");
    expect(existsSync(join(root, "runs"))).toBe(true);
    expect(readdirSync(join(root, "runs"))).toEqual([]);
    expect(approvalYaml).toContain("approval");
  });
});
