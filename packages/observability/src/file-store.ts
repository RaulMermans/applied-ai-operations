import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { TraceEvent } from "@aao/contracts";
import { serializeTraceEvent } from "./content-policy.js";
import { ImmutableFileExistsError, UnsafeStorePathError, assertDirectory, ensureDirectory, eventFileName, isDirectory, readEventFiles, writeImmutableFile } from "./local-files.js";
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
    const files = readEventFiles(dir, 1024 * 1024);
    if (!files.ok) throw new TraceStoreError("TRACE_STORE_CORRUPT");
    const raw = files.raw;
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
        writeImmutable(join(dir, eventFileName(parsed.sequence)), `${serializeTraceEvent(parsed)}\n`);
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

function writeImmutable(path: string, content: string): void {
  try {
    writeImmutableFile(path, content);
  } catch (error) {
    if (error instanceof ImmutableFileExistsError) throw new TraceStoreError("TRACE_SEQUENCE_CONFLICT");
    throw error;
  }
}

function redact(error: unknown): TraceStoreError {
  if (error instanceof UnsafeStorePathError) return new TraceStoreError("TRACE_STORE_CORRUPT");
  return error instanceof TraceStoreError ? error : new TraceStoreError("TRACE_STORE_FAILURE");
}
