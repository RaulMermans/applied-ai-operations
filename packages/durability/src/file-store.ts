import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { ZodType } from "zod";
import { ApprovalIdSchema, ApprovalRecordSchema, RunIdSchema, isoTimestampSchema, type ApprovalRecord } from "@aao/contracts";
import type { ApprovalRepository } from "@aao/approval";
import { isJsonSafe, parseNodeAttemptOutcome, type NodeAttemptOutcome } from "@aao/runtime";
import { CancellationRecordSchema, DurabilityError, DurableCheckpointSchema, DurableOperationSchema, MAX_RECOVERY_REPLAYS, RunManifestSchema, durabilityCodeOf, type CancellationRecord, type DurableCheckpoint, type DurableOperation, type RunManifest } from "./contracts.js";
import type { DurabilityStore } from "./store.js";

/**
 * Local filesystem reference `DurabilityStore` (ADR-019): local,
 * single-host, single-writer, and restart-durable. Not distributed,
 * multi-worker, multi-host, highly available, or cloud persistence.
 *
 * Layout (boring and inspectable; directory names are SHA-256 hex of the
 * validated identifier, so no caller-supplied text ever becomes a path):
 *
 *   <root>/runs/<sha256(runId)>/manifest.json
 *                              /checkpoints/000000.json, 000001.json, …   (immutable)
 *                              /operations/s000001-a1.json, …
 *                              /cancellation.json
 *   <root>/approvals/<sha256(approvalId)>.json
 *
 * Every authoritative write is atomic: serialize + validate → write a
 * same-directory temp file → fsync → rename (or hard-link for
 * create-if-absent) → fsync the directory where supported. A temp file is
 * never authoritative and is ignored on load. A Run is created by renaming a
 * fully written staging directory into place, so a Run either exists with
 * its manifest and checkpoint 0 or does not exist at all.
 */
export function createFileDurabilityStore(options: { root: string }): DurabilityStore {
  if (typeof options?.root !== "string" || options.root.length === 0) throw new DurabilityError("DURABILITY_INVALID_INPUT");
  let root: string;
  try {
    mkdirSync(options.root, { recursive: true });
    root = realpathSync(options.root);
    ensureDirectory(join(root, "runs"));
    ensureDirectory(join(root, "approvals"));
  } catch (error) {
    throw new DurabilityError(durabilityCodeOf(error));
  }
  const runsDir = join(root, "runs");
  const approvalsDir = join(root, "approvals");

  // Per-Run serialization of mutations inside this store instance.
  const locks = new Map<string, Promise<unknown>>();
  function serialized<T>(runId: string, work: () => T): Promise<T> {
    const previous = locks.get(runId) ?? Promise.resolve();
    const next = previous.then(() => guard(work), () => guard(work));
    locks.set(runId, next.catch(() => undefined));
    return next;
  }
  const read = <T>(work: () => T): Promise<T> => {
    try { return Promise.resolve(work()); } catch (error) { return Promise.reject(redact(error)); }
  };

  function runDir(runId: string): string {
    if (!RunIdSchema.safeParse(runId).success) throw new DurabilityError("DURABILITY_INVALID_INPUT");
    return join(runsDir, keyFor("run", runId));
  }
  function existingRunDir(runId: string): string {
    const dir = runDir(runId);
    if (!isDirectory(dir)) throw new DurabilityError("DURABLE_RUN_NOT_FOUND");
    return dir;
  }
  function loadManifest(runId: string): RunManifest {
    const manifest = readRecord(join(existingRunDir(runId), "manifest.json"), RunManifestSchema);
    if (!manifest || manifest.runId !== runId) throw new DurabilityError("DURABILITY_CORRUPT_STATE");
    return manifest;
  }
  function loadCheckpoints(runId: string): DurableCheckpoint[] {
    const manifest = loadManifest(runId);
    const dir = join(existingRunDir(runId), "checkpoints");
    assertDirectory(dir);
    const names = listRecords(dir);
    const checkpoints: DurableCheckpoint[] = [];
    names.forEach((name, index) => {
      // Contiguous, gap-free, monotonic sequences 0..N: anything else is corruption.
      if (name !== `${String(index).padStart(6, "0")}.json`) throw new DurabilityError("DURABILITY_CORRUPT_STATE");
      const checkpoint = readRecord(join(dir, name), DurableCheckpointSchema);
      if (!checkpoint || checkpoint.sequence !== index || checkpoint.runId !== runId || checkpoint.planFingerprint !== manifest.planFingerprint || checkpoint.workflowId !== manifest.workflowId || checkpoint.workflowVersion !== manifest.workflowVersion || checkpoint.executionSnapshot.run.createdAt !== manifest.createdAt) {
        throw new DurabilityError("DURABILITY_CORRUPT_STATE");
      }
      checkpoints.push(checkpoint);
    });
    if (checkpoints.length === 0) throw new DurabilityError("DURABILITY_CORRUPT_STATE");
    return checkpoints;
  }
  function operationPath(runId: string, step: number, attempt: number): string {
    return join(existingRunDir(runId), "operations", `s${String(step).padStart(6, "0")}-a${attempt}.json`);
  }
  function loadOperation(runId: string, operationId: string): { operation: DurableOperation; path: string } {
    const match = /^op\.s([1-9][0-9]{0,8})\.a([1-9][0-9]{0,2})$/.exec(operationId);
    if (!match) throw new DurabilityError("DURABILITY_INVALID_INPUT");
    const path = operationPath(runId, Number(match[1]), Number(match[2]));
    const operation = readRecord(path, DurableOperationSchema);
    if (!operation) throw new DurabilityError("DURABILITY_CONFLICT");
    if (operation.runId !== runId || operation.operationId !== operationId) throw new DurabilityError("DURABILITY_CORRUPT_STATE");
    return { operation, path };
  }

  const approvals: ApprovalRepository = Object.freeze({
    get(approvalId: string): ApprovalRecord | undefined {
      return guard(() => {
        const record = readRecord(approvalPath(approvalId), ApprovalRecordSchema);
        if (record && record.approvalId !== approvalId) throw new DurabilityError("DURABILITY_CORRUPT_STATE");
        return record ? deepFreeze(record) : undefined;
      });
    },
    create(record: ApprovalRecord): ApprovalRecord {
      return guard(() => {
        const path = approvalPath(record.approvalId);
        // Never overwrite: an existing record under this id is returned for the engine's exact-request check.
        if (!exists(path)) writeRecord(path, ApprovalRecordSchema, record, "create-if-absent");
        const stored = readRecord(path, ApprovalRecordSchema);
        if (!stored || stored.approvalId !== record.approvalId) throw new DurabilityError("DURABILITY_CORRUPT_STATE");
        return deepFreeze(stored);
      });
    },
    // Synchronous read-check-write: atomic within this single-writer process; the rename never exposes a partial record.
    compareAndSetResolution(approvalId: string, resolved: ApprovalRecord): boolean {
      return guard(() => {
        const path = approvalPath(approvalId);
        const current = readRecord(path, ApprovalRecordSchema);
        if (!current || current.status !== "pending" || resolved.approvalId !== approvalId || resolved.status === "pending") return false;
        if (current.runId !== resolved.runId || current.nodeId !== resolved.nodeId || current.requestFingerprint !== resolved.requestFingerprint) throw new DurabilityError("DURABILITY_CONFLICT");
        writeRecord(path, ApprovalRecordSchema, resolved, "replace");
        return true;
      });
    },
  });
  function approvalPath(approvalId: string): string {
    if (!ApprovalIdSchema.safeParse(approvalId).success) throw new DurabilityError("DURABILITY_INVALID_INPUT");
    return join(approvalsDir, `${keyFor("approval", approvalId)}.json`);
  }

  return Object.freeze({
    approvals,

    createRun(manifest: RunManifest, initialCheckpoint: DurableCheckpoint): Promise<void> {
      return serialized(manifest?.runId, () => {
        const parsedManifest = parseOrThrow(RunManifestSchema, manifest);
        const checkpoint = parseOrThrow(DurableCheckpointSchema, initialCheckpoint);
        if (checkpoint.sequence !== 0 || checkpoint.runId !== parsedManifest.runId || checkpoint.planFingerprint !== parsedManifest.planFingerprint || checkpoint.executionSnapshot.run.createdAt !== parsedManifest.createdAt) throw new DurabilityError("DURABILITY_INVALID_INPUT");
        const target = runDir(parsedManifest.runId);
        if (exists(target)) throw new DurabilityError("DURABLE_RUN_ALREADY_EXISTS");
        const staging = join(runsDir, `.tmp-run-${randomUUID()}`);
        try {
          mkdirSync(join(staging, "checkpoints"), { recursive: true });
          mkdirSync(join(staging, "operations"));
          writeRecord(join(staging, "manifest.json"), RunManifestSchema, parsedManifest, "create-if-absent");
          writeRecord(join(staging, "checkpoints", "000000.json"), DurableCheckpointSchema, checkpoint, "create-if-absent");
          fsyncDirectory(staging);
          try {
            renameSync(staging, target);
          } catch {
            throw new DurabilityError(exists(target) ? "DURABLE_RUN_ALREADY_EXISTS" : "DURABILITY_IO_FAILED");
          }
          fsyncDirectory(runsDir);
        } finally {
          rmSync(staging, { recursive: true, force: true });
        }
      });
    },

    getRun(runId: string): Promise<RunManifest | undefined> {
      return read(() => (isDirectory(runDir(runId)) ? loadManifest(runId) : undefined));
    },

    writeCheckpoint(checkpoint: DurableCheckpoint): Promise<void> {
      return serialized(checkpoint?.runId, () => {
        const parsed = parseOrThrow(DurableCheckpointSchema, checkpoint);
        const existing = loadCheckpoints(parsed.runId);
        const latest = existing[existing.length - 1]!;
        if (parsed.sequence !== latest.sequence + 1 || parsed.planFingerprint !== latest.planFingerprint) throw new DurabilityError("DURABILITY_CONFLICT");
        writeRecord(join(existingRunDir(parsed.runId), "checkpoints", `${String(parsed.sequence).padStart(6, "0")}.json`), DurableCheckpointSchema, parsed, "create-if-absent");
      });
    },

    getLatestCheckpoint(runId: string): Promise<DurableCheckpoint | undefined> {
      return read(() => {
        if (!isDirectory(runDir(runId))) return undefined;
        const checkpoints = loadCheckpoints(runId);
        return checkpoints[checkpoints.length - 1];
      });
    },

    beginOperation(operation: DurableOperation): Promise<void> {
      return serialized(operation?.runId, () => {
        const parsed = parseOrThrow(DurableOperationSchema, operation);
        if (parsed.status !== "STARTED" || parsed.recoveryReplayCount !== 0) throw new DurabilityError("DURABILITY_INVALID_INPUT");
        loadManifest(parsed.runId);
        writeRecord(operationPath(parsed.runId, parsed.step, parsed.attempt), DurableOperationSchema, parsed, "create-if-absent");
      });
    },

    markOperationReplay(runId: string, operationId: string, expectedReplayCount: number): Promise<void> {
      return serialized(runId, () => {
        const { operation, path } = loadOperation(runId, operationId);
        if (operation.status !== "STARTED" || operation.recoveryReplayCount !== expectedReplayCount || expectedReplayCount >= MAX_RECOVERY_REPLAYS) throw new DurabilityError("DURABILITY_CONFLICT");
        writeRecord(path, DurableOperationSchema, { ...operation, recoveryReplayCount: expectedReplayCount + 1 }, "replace");
      });
    },

    recordOperationOutcome(runId: string, operationId: string, outcome: NodeAttemptOutcome, completedAt: string): Promise<void> {
      return serialized(runId, () => {
        const validated = parseNodeAttemptOutcome(outcome);
        if (!validated || !isoTimestampSchema.safeParse(completedAt).success) throw new DurabilityError("DURABILITY_INVALID_INPUT");
        const { operation, path } = loadOperation(runId, operationId);
        if (operation.status !== "STARTED") throw new DurabilityError("DURABILITY_CONFLICT");
        writeRecord(path, DurableOperationSchema, { ...operation, status: "OUTCOME_RECORDED", completedAt, outcome: validated }, "replace");
      });
    },

    getOperationsForRun(runId: string): Promise<DurableOperation[]> {
      return read(() => {
        const dir = join(existingRunDir(runId), "operations");
        assertDirectory(dir);
        const operations = listRecords(dir).map((name) => {
          const match = /^s([0-9]{6,9})-a([1-9][0-9]{0,2})\.json$/.exec(name);
          const operation = match ? readRecord(join(dir, name), DurableOperationSchema) : undefined;
          if (!match || !operation || operation.runId !== runId || operation.step !== Number(match[1]) || operation.attempt !== Number(match[2])) throw new DurabilityError("DURABILITY_CORRUPT_STATE");
          return operation;
        });
        return operations.sort((a, b) => a.step - b.step || a.attempt - b.attempt);
      });
    },

    requestCancellation(runId: string, requestedAt: string): Promise<CancellationRecord> {
      return serialized(runId, () => {
        const path = join(existingRunDir(runId), "cancellation.json");
        if (!exists(path)) writeRecord(path, CancellationRecordSchema, { schemaVersion: 1, runId, requestedAt }, "create-if-absent");
        const record = readRecord(path, CancellationRecordSchema);
        if (!record || record.runId !== runId) throw new DurabilityError("DURABILITY_CORRUPT_STATE");
        return record;
      });
    },

    getCancellation(runId: string): Promise<CancellationRecord | undefined> {
      return read(() => {
        const record = readRecord(join(existingRunDir(runId), "cancellation.json"), CancellationRecordSchema);
        if (record && record.runId !== runId) throw new DurabilityError("DURABILITY_CORRUPT_STATE");
        return record;
      });
    },
  });
}

/** Directory/file key for a validated identifier: domain-separated SHA-256 hex, so no identifier text reaches a path. */
function keyFor(domain: "run" | "approval", id: string): string {
  return createHash("sha256").update(JSON.stringify(["aao.durability.v1", domain, id])).digest("hex");
}

const MAX_RECORD_BYTES = 16 * 1024 * 1024;

/** Reads one authoritative record. Missing → undefined. Symlink, oversize, malformed JSON, or schema mismatch → corrupt. */
function readRecord<T>(path: string, schema: ZodType<T>): T | undefined {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (isMissing(error)) return undefined; throw error; }
  if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw new DurabilityError("DURABILITY_CORRUPT_STATE");
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { throw new DurabilityError("DURABILITY_CORRUPT_STATE"); }
  const parsed = isJsonSafe(raw) ? schema.safeParse(raw) : undefined;
  if (!parsed?.success) throw new DurabilityError("DURABILITY_CORRUPT_STATE");
  return parsed.data;
}

/** Validates, then writes atomically. `create-if-absent` fails with DURABILITY_CONFLICT if the record exists; `replace` atomically supersedes it. */
function writeRecord<T>(path: string, schema: ZodType<T>, value: T, mode: "create-if-absent" | "replace"): void {
  const parsed = schema.safeParse(value);
  if (!parsed.success || !isJsonSafe(parsed.data)) throw new DurabilityError("DURABILITY_INVALID_INPUT");
  const dir = join(path, "..");
  assertDirectory(dir);
  const temp = join(dir, `.tmp-${randomUUID()}`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(parsed.data, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (mode === "create-if-absent") {
      try {
        linkSync(temp, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "EEXIST") throw new DurabilityError("DURABILITY_CONFLICT");
        throw error;
      }
    } else {
      const current = lstatSync(path);
      if (!current.isFile()) throw new DurabilityError("DURABILITY_CORRUPT_STATE");
      renameSync(temp, path);
    }
  } finally {
    try { unlinkSync(temp); } catch { /* already renamed into place */ }
  }
  fsyncDirectory(dir);
}

function parseOrThrow<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = isJsonSafe(value) ? schema.safeParse(value) : undefined;
  if (!parsed?.success) throw new DurabilityError("DURABILITY_INVALID_INPUT");
  return parsed.data;
}

/** Authoritative records only: temp files are never authoritative. */
function listRecords(dir: string): string[] {
  return readdirSync(dir).filter((name) => !name.startsWith(".tmp-")).sort();
}

function ensureDirectory(path: string): void {
  try { mkdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error; }
  assertDirectory(path);
}

/** A symlink or non-directory where a store directory belongs could escape the root: fail closed. */
function assertDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new DurabilityError("DURABILITY_CORRUPT_STATE");
}

function isDirectory(path: string): boolean {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (isMissing(error)) return false; throw error; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new DurabilityError("DURABILITY_CORRUPT_STATE");
  return true;
}

function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if (isMissing(error)) return false; throw error; }
}

function fsyncDirectory(dir: string): void {
  // Directory fsync is unsupported on some platforms/filesystems; the rename itself is still atomic there.
  let fd: number | undefined;
  try { fd = openSync(dir, "r"); fsyncSync(fd); } catch { /* best effort */ } finally { if (fd !== undefined) closeSync(fd); }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Runs filesystem work, converting every failure into a redacted DurabilityError: no path or OS message escapes. */
function guard<T>(work: () => T): T {
  try { return work(); } catch (error) { throw redact(error); }
}

function redact(error: unknown): DurabilityError {
  return error instanceof DurabilityError ? error : new DurabilityError("DURABILITY_IO_FAILED");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
