import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

/**
 * The one local immutable-file write path shared by the Trace and Audit file
 * stores (ADR-020/ADR-021): validate first (caller), then write a
 * same-directory temp file, fsync it, hard-link it into place
 * create-if-absent (a committed file is never overwritten), and fsync the
 * directory. A temp file is never evidence and is ignored on load. Errors
 * are mapped by the caller into its own redacted store error.
 */

/** Thrown when the destination already exists: a committed event file is never replaced. */
export class ImmutableFileExistsError extends Error {
  constructor() {
    super("EEXIST");
    this.name = "ImmutableFileExistsError";
  }
}

/** Thrown when a store directory is a symlink or not a directory (a possible root escape): fail closed. */
export class UnsafeStorePathError extends Error {
  constructor() {
    super("UNSAFE_PATH");
    this.name = "UnsafeStorePathError";
  }
}

export const TEMP_FILE_PREFIX = ".tmp-";

export function eventFileName(sequence: number): string {
  return `${String(sequence).padStart(9, "0")}.json`;
}

export function writeImmutableFile(path: string, content: string): void {
  const dir = join(path, "..");
  const temp = join(dir, `${TEMP_FILE_PREFIX}${randomUUID()}`);
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
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") throw new ImmutableFileExistsError();
    throw error;
  } finally {
    try { unlinkSync(temp); } catch { /* best effort */ }
  }
  let dirFd: number | undefined;
  try { dirFd = openSync(dir, "r"); fsyncSync(dirFd); } catch { /* directory fsync is unsupported on some platforms */ } finally { if (dirFd !== undefined) closeSync(dirFd); }
}

export function ensureDirectory(path: string): void {
  try { mkdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error; }
  assertDirectory(path);
}

export function assertDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new UnsafeStorePathError();
}

/** False when absent; throws `UnsafeStorePathError` for a symlink or non-directory. */
export function isDirectory(path: string): boolean {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false; throw error; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new UnsafeStorePathError();
  return true;
}

/**
 * Reads an events directory as raw parsed JSON in file order. Returns
 * `{ ok: false }` when a file name breaks contiguity, a file is not a
 * regular bounded file, or content is not JSON — the caller decides what
 * that means (corruption).
 */
export function readEventFiles(dir: string, maxFileBytes: number): { ok: true; raw: unknown[] } | { ok: false } {
  assertDirectory(dir);
  const names = readdirSync(dir).filter((name) => !name.startsWith(TEMP_FILE_PREFIX)).sort();
  const raw: unknown[] = [];
  for (const [index, name] of names.entries()) {
    if (name !== eventFileName(index)) return { ok: false };
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > maxFileBytes) return { ok: false };
    try { raw.push(JSON.parse(readFileSync(path, "utf8")) as unknown); } catch { return { ok: false }; }
  }
  return { ok: true, raw };
}

/**
 * Reads every committed event file for *verification*, in name order,
 * without enforcing contiguity: an unreadable, oversized, or non-JSON file
 * becomes `null` so the validator reports it at its position instead of the
 * whole read failing. Never used to extend a stream.
 */
export function readEventFilesForVerification(dir: string, maxFileBytes: number): unknown[] {
  assertDirectory(dir);
  return readdirSync(dir).filter((name) => !name.startsWith(TEMP_FILE_PREFIX)).sort().map((name) => {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > maxFileBytes) return null;
    try { return JSON.parse(readFileSync(path, "utf8")) as unknown; } catch { return null; }
  });
}
