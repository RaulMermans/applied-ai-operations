import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { AuditEvent } from "@aao/contracts";
import { ImmutableFileExistsError, UnsafeStorePathError, assertDirectory, ensureDirectory, eventFileName, isDirectory, readEventFiles, readEventFilesForVerification, writeImmutableFile } from "../local-files.js";
import { serializeAuditEvent } from "./event.js";
import { AuditStoreError, AuditStreamLog, assertAuditEventId, assertStreamId, cloneAuditEvent, validatedAuditForAppend, type AuditStore } from "./store.js";
import { validateAuditStream } from "./validator.js";

/**
 * Local persistent reference `AuditStore` (ADR-021): local, single-host,
 * single-writer, restart-durable. No database, SIEM, or audit vendor.
 * Layout (inspectable; the directory is SHA-256 of the validated stream id,
 * so no caller text becomes a path):
 *
 *   <root>/streams/<sha256(streamId)>/events/000000000.json, 000000001.json, …
 *
 * One immutable file per event, written by the same path as the Trace store:
 * validate → temp write → fsync → create-if-absent hard link → directory
 * fsync. Loading verifies schema, contiguity, identity, and the hash chain;
 * a stream failing that is `AUDIT_STORE_CORRUPT` and is never extended.
 * `verifyStream` reads raw files and reports tampering without throwing.
 */
export function createFileAuditStore(options: { root: string }): AuditStore {
  if (typeof options?.root !== "string" || options.root.length === 0) throw new AuditStoreError("AUDIT_STORE_FAILURE");
  let streamsDir: string;
  try {
    mkdirSync(options.root, { recursive: true });
    streamsDir = join(realpathSync(options.root), "streams");
    ensureDirectory(streamsDir);
  } catch (error) {
    throw redact(error);
  }

  const cache = new Map<string, AuditStreamLog>();
  const locks = new Map<string, Promise<unknown>>();
  function serialized<T>(streamId: string, work: () => T): Promise<T> {
    const previous = locks.get(streamId) ?? Promise.resolve();
    const next = previous.then(() => guarded(streamId, work), () => guarded(streamId, work));
    locks.set(streamId, next.catch(() => undefined));
    return next;
  }
  function guarded<T>(streamId: string, work: () => T): T {
    try { return work(); } catch (error) { cache.delete(streamId); throw redact(error); }
  }

  function eventsDir(streamId: string): string {
    const key = createHash("sha256").update(JSON.stringify(["aao.audit-store.v1", "stream", streamId])).digest("hex");
    return join(streamsDir, key, "events");
  }

  function readRaw(streamId: string): unknown[] {
    const dir = eventsDir(streamId);
    if (!isDirectory(join(dir, ".."))) return [];
    const files = readEventFiles(dir, 256 * 1024);
    if (!files.ok) throw new AuditStoreError("AUDIT_STORE_CORRUPT");
    return files.raw;
  }

  function load(streamId: string): AuditStreamLog {
    const cached = cache.get(streamId);
    if (cached) return cached;
    const log = AuditStreamLog.load(streamId, readRaw(streamId));
    cache.set(streamId, log);
    return log;
  }

  return Object.freeze({
    async append(event: AuditEvent) {
      return serialized(event?.streamId, () => {
        const parsed = validatedAuditForAppend(event);
        const log = load(parsed.streamId);
        if (log.decide(parsed) === "duplicate") return "duplicate" as const;
        const dir = eventsDir(parsed.streamId);
        mkdirSync(dir, { recursive: true });
        assertDirectory(join(dir, ".."));
        assertDirectory(dir);
        try {
          writeImmutableFile(join(dir, eventFileName(parsed.sequence)), `${serializeAuditEvent(parsed)}\n`);
        } catch (error) {
          if (error instanceof ImmutableFileExistsError) throw new AuditStoreError("AUDIT_SEQUENCE_CONFLICT");
          throw error;
        }
        log.commit(cloneAuditEvent(parsed));
        return "appended" as const;
      });
    },
    async getStream(streamId: string) {
      return serialized(assertStreamId(streamId), () => load(streamId).events.map(cloneAuditEvent));
    },
    async getEvent(streamId: string, eventId: string) {
      return serialized(assertStreamId(streamId), () => {
        const event = load(streamId).get(assertAuditEventId(eventId));
        return event ? cloneAuditEvent(event) : undefined;
      });
    },
    async verifyStream(streamId: string) {
      return serialized(assertStreamId(streamId), () => {
        // Always from disk, bypassing the cache: verification must see what is actually stored.
        const dir = eventsDir(streamId);
        if (!isDirectory(join(dir, ".."))) return validateAuditStream([], { streamId });
        return validateAuditStream(readEventFilesForVerification(dir, 256 * 1024), { streamId });
      });
    },
  } satisfies AuditStore);
}

function redact(error: unknown): AuditStoreError {
  if (error instanceof UnsafeStorePathError) return new AuditStoreError("AUDIT_STORE_CORRUPT");
  return error instanceof AuditStoreError ? error : new AuditStoreError("AUDIT_STORE_FAILURE");
}
