import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { TraceEvent } from "@aao/contracts";
import { serializeTraceEvent } from "./content-policy.js";
import { TraceRunLog, TraceStoreError, assertEventId, assertRunId, cloneEvent, validatedForAppend, type TraceStore } from "./store.js";

/**
 * Local persistent reference `TraceStore` (ADR-020): local, single-host,
 * single-writer, restart-durable. Not a database, collector, or vendor
 * backend. Layout (boring and inspectable; the directory name is SHA-256 of
 * the validated runId, so no caller text becomes a path):
 *
 *   <root>/runs/<sha256(runId)>/events/000000000.json, 000000001.json, …
 *
 * One immutable file per event. Each append validates the event, writes a
 * same-directory temp file, fsyncs it, and hard-links it into place
 * (create-if-absent, so a committed event is never overwritten), then
 * fsyncs the directory. A temp file is never authoritative and is ignored
 * on load; a partial event therefore never appears as Trace data. Loading
 * validates every event, contiguous sequences, unique ids, and one trace
 * and workflow identity; anything else is `TRACE_STORE_CORRUPT`.
 */
export function createFileTraceStore(options: { root: string }): TraceStore {
  if (typeof options?.root !== "string" || options.root.length === 0) throw new TraceStoreError("TRACE_STORE_FAILURE");
  let runsDir: string;
  try {
    mkdirSync(options.root, { recursive: true });
    runsDir = join(realpathSync(options.root), "runs");
    ensureDirectory(runsDir);
  } catch (error) {
    throw redact(error);
  }

  // Validated per-Run cache inside this single-writer instance; dropped on any failure so the next access reloads from disk.
  const cache = new Map<string, TraceRunLog>();
  const locks = new Map<string, Promise<unknown>>();
  function serialized<T>(runId: string, work: () => T): Promise<T> {
    const previous = locks.get(runId) ?? Promise.resolve();
    const next = previous.then(() => guarded(runId, work), () => guarded(runId, work));
    locks.set(runId, next.catch(() => undefined));
    return next;
  }
  function guarded<T>(runId: string, work: () => T): T {
    try { return work(); } catch (error) { cache.delete(runId); throw redact(error); }
  }

  function eventsDir(runId: string): string {
    const key = createHash("sha256").update(JSON.stringify(["aao.trace-store.v1", "run", runId])).digest("hex");
    return join(runsDir, key, "events");
  }

  function load(runId: string): TraceRunLog {
    const cached = cache.get(runId);
    if (cached) return cached;
    const dir = eventsDir(runId);
    if (!isDirectory(join(dir, ".."))) return new TraceRunLog();
    assertDirectory(dir);
    const names = readdirSync(dir).filter((name) => !name.startsWith(".tmp-")).sort();
    const raw = names.map((name, index) => {
      if (name !== fileName(index)) throw new TraceStoreError("TRACE_STORE_CORRUPT");
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new TraceStoreError("TRACE_STORE_CORRUPT");
      try { return JSON.parse(readFileSync(path, "utf8")) as unknown; } catch { throw new TraceStoreError("TRACE_STORE_CORRUPT"); }
    });
    const log = TraceRunLog.load(runId, raw);
    cache.set(runId, log);
    return log;
  }

  return Object.freeze({
    async append(event: TraceEvent) {
      return serialized(event?.runId, () => {
        const parsed = validatedForAppend(event);
        const log = load(parsed.runId);
        if (log.decide(parsed) === "duplicate") return "duplicate" as const;
        const dir = eventsDir(parsed.runId);
        mkdirSync(dir, { recursive: true });
        assertDirectory(join(dir, ".."));
        assertDirectory(dir);
        writeImmutable(join(dir, fileName(parsed.sequence)), `${serializeTraceEvent(parsed)}\n`);
        log.commit(cloneEvent(parsed));
        return "appended" as const;
      });
    },
    async getRunTrace(runId: string) {
      return serialized(assertRunId(runId), () => load(runId).events.map(cloneEvent));
    },
    async getEvent(runId: string, eventId: string) {
      return serialized(assertRunId(runId), () => {
        const event = load(runId).get(assertEventId(eventId));
        return event ? cloneEvent(event) : undefined;
      });
    },
    async getLastSequence(runId: string) {
      return serialized(assertRunId(runId), () => load(runId).events.length - 1);
    },
  } satisfies TraceStore);
}

function fileName(sequence: number): string {
  return `${String(sequence).padStart(9, "0")}.json`;
}

function writeImmutable(path: string, content: string): void {
  const dir = join(path, "..");
  const temp = join(dir, `.tmp-${randomUUID()}`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temp, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") throw new TraceStoreError("TRACE_SEQUENCE_CONFLICT");
    throw error;
  } finally {
    try { unlinkSync(temp); } catch { /* best effort */ }
  }
  let dirFd: number | undefined;
  try { dirFd = openSync(dir, "r"); fsyncSync(dirFd); } catch { /* directory fsync is unsupported on some platforms */ } finally { if (dirFd !== undefined) closeSync(dirFd); }
}

function ensureDirectory(path: string): void {
  try { mkdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error; }
  assertDirectory(path);
}

/** A symlink or non-directory where a store directory belongs could escape the root: fail closed. */
function assertDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new TraceStoreError("TRACE_STORE_CORRUPT");
}

function isDirectory(path: string): boolean {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false; throw error; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new TraceStoreError("TRACE_STORE_CORRUPT");
  return true;
}

function redact(error: unknown): TraceStoreError {
  return error instanceof TraceStoreError ? error : new TraceStoreError("TRACE_STORE_FAILURE");
}
