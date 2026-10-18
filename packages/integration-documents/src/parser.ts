import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { DOCUMENT_LIMITS } from "./limits.js";
import { PDF_WORKER_SCRIPT } from "./pdf-worker.js";
import { normalizeCanonicalPageText, safeSliceUtf16 } from "./text.js";

export interface ExtractedDocumentPage {
  /** 1-based page index. Always contiguous from 1..N. */
  readonly pageNumber: number;
  /** Normalized canonical page text. */
  readonly text: string;
  /** Length of canonical page text in UTF-16 code units. Must equal text.length. */
  readonly charCount: number;
}

export type DocumentParserResult =
  | {
      readonly ok: true;
      readonly pages: readonly ExtractedDocumentPage[];
      readonly pagesTotal: number;
      readonly pagesExtracted: number;
      readonly charactersExtracted: number;
      readonly partialReasons: readonly string[];
      readonly isPartial: boolean;
    }
  | {
      readonly ok: false;
      readonly code:
        | "DOCUMENT_TYPE_UNSUPPORTED"
        | "DOCUMENT_PARSE_FAILED"
        | "DOCUMENT_NO_EXTRACTABLE_TEXT"
        | "CANCELLED"
        | "DOCUMENT_PARSER_BUSY";
    };

export interface WorkerLike {
  on(event: "message", listener: (value: unknown) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "exit", listener: (exitCode: number) => void): this;
  terminate(): Promise<number>;
}

export interface WorkerFactoryOptions {
  readonly eval: boolean;
  readonly workerData: unknown;
  readonly resourceLimits: {
    readonly maxOldGenerationSizeMb: number;
    readonly maxYoungGenerationSizeMb: number;
    readonly stackSizeMb: number;
  };
}

export type PdfWorkerFactory = (options: WorkerFactoryOptions) => WorkerLike;

export interface ParseDocumentOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** @internal Private test seam: alternative worker factory for deterministic lifecycle testing. */
  readonly _workerFactory?: PdfWorkerFactory;
}

const MIN_PARSER_TIMEOUT_MS = 1;
const MAX_PARSER_TIMEOUT_MS = 300_000;

/**
 * Synchronous permit counter scoped to the document integration module / process (Sprint 23D).
 * Tracks physical host worker concurrency without storing any document state, refs, or secrets.
 */
let activePdfWorkers = 0;
let injectedWorkerFactory: PdfWorkerFactory | null = null;

interface WorkerPermit {
  release(): void;
}

function tryAcquirePdfWorkerPermit(): WorkerPermit | null {
  if (activePdfWorkers >= DOCUMENT_LIMITS.maxConcurrentPdfWorkers) {
    return null;
  }
  activePdfWorkers++;
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      activePdfWorkers = Math.max(0, activePdfWorkers - 1);
    },
  };
}

export function _getActivePdfWorkerCountForTest(): number {
  return activePdfWorkers;
}

export function _setWorkerFactoryForTest(factory: PdfWorkerFactory | null): void {
  injectedWorkerFactory = factory;
}

export function _resetWorkerAdmissionForTest(): void {
  activePdfWorkers = 0;
  injectedWorkerFactory = null;
}

function resolveTimeoutMs(timeoutMs?: number): number {
  if (timeoutMs === undefined) return DOCUMENT_LIMITS.defaultParserTimeoutMs;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isFinite(timeoutMs) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_PARSER_TIMEOUT_MS
  ) {
    return DOCUMENT_LIMITS.defaultParserTimeoutMs;
  }
  return Math.min(timeoutMs, MAX_PARSER_TIMEOUT_MS);
}

function validateWorkerMessage(msg: unknown): DocumentParserResult {
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
    return { ok: false, code: "DOCUMENT_PARSE_FAILED" };
  }

  const record = msg as Record<string, unknown>;

  if (record.ok === false) {
    const code = record.code;
    if (
      code === "DOCUMENT_PARSE_FAILED" ||
      code === "DOCUMENT_NO_EXTRACTABLE_TEXT" ||
      code === "DOCUMENT_TYPE_UNSUPPORTED" ||
      code === "CANCELLED"
    ) {
      return { ok: false, code };
    }
    return { ok: false, code: "DOCUMENT_PARSE_FAILED" };
  }

  if (record.ok === true) {
    if (!Array.isArray(record.pages) || record.pages.length === 0) {
      return { ok: false, code: "DOCUMENT_PARSE_FAILED" };
    }

    const pages: ExtractedDocumentPage[] = [];
    let expectedPageNumber = 1;
    let computedChars = 0;

    for (const rawPage of record.pages) {
      if (rawPage === null || typeof rawPage !== "object" || Array.isArray(rawPage)) {
        return { ok: false, code: "DOCUMENT_PARSE_FAILED" };
      }
      const pageObj = rawPage as Record<string, unknown>;
      if (
        typeof pageObj.pageNumber !== "number" ||
        !Number.isInteger(pageObj.pageNumber) ||
        pageObj.pageNumber !== expectedPageNumber
      ) {
        return { ok: false, code: "DOCUMENT_PARSE_FAILED" };
      }
      if (typeof pageObj.text !== "string") {
        return { ok: false, code: "DOCUMENT_PARSE_FAILED" };
      }
      if (
        typeof pageObj.charCount !== "number" ||
        !Number.isInteger(pageObj.charCount) ||
        pageObj.charCount !== pageObj.text.length
      ) {
        return { ok: false, code: "DOCUMENT_PARSE_FAILED" };
      }

      pages.push({
        pageNumber: pageObj.pageNumber,
        text: pageObj.text,
        charCount: pageObj.charCount,
      });

      computedChars += pageObj.charCount;
      expectedPageNumber++;
    }

    if (
      typeof record.pagesTotal !== "number" ||
      !Number.isInteger(record.pagesTotal) ||
      record.pagesTotal < pages.length
    ) {
      return { ok: false, code: "DOCUMENT_PARSE_FAILED" };
    }

    if (
      typeof record.pagesExtracted !== "number" ||
      !Number.isInteger(record.pagesExtracted) ||
      record.pagesExtracted !== pages.length
    ) {
      return { ok: false, code: "DOCUMENT_PARSE_FAILED" };
    }

    if (
      typeof record.charactersExtracted !== "number" ||
      !Number.isInteger(record.charactersExtracted) ||
      record.charactersExtracted !== computedChars
    ) {
      return { ok: false, code: "DOCUMENT_PARSE_FAILED" };
    }

    if (
      !Array.isArray(record.partialReasons) ||
      !record.partialReasons.every((r) => typeof r === "string")
    ) {
      return { ok: false, code: "DOCUMENT_PARSE_FAILED" };
    }

    if (typeof record.isPartial !== "boolean" || record.isPartial !== (record.partialReasons.length > 0)) {
      return { ok: false, code: "DOCUMENT_PARSE_FAILED" };
    }

    return {
      ok: true,
      pages: Object.freeze(pages),
      pagesTotal: record.pagesTotal,
      pagesExtracted: record.pagesExtracted,
      charactersExtracted: record.charactersExtracted,
      partialReasons: Object.freeze([...record.partialReasons]),
      isPartial: record.isPartial,
    };
  }

  return { ok: false, code: "DOCUMENT_PARSE_FAILED" };
}

/**
 * Parses raw document bytes according to its MIME type into canonical pages.
 * Supports only `application/pdf` and `text/plain`.
 * Returns normalized failures for unsupported types, corrupt PDFs, or documents with no extractable text.
 * PDF parsing executes inside an isolated worker thread so host globals are never mutated.
 */
export async function parseDocumentBytes(
  bytes: Uint8Array,
  mimeType: string,
  options?: ParseDocumentOptions
): Promise<DocumentParserResult> {
  const normalizedMime = mimeType.trim().toLowerCase();

  if (normalizedMime === "text/plain") {
    return parsePlainText(bytes);
  }

  if (normalizedMime === "application/pdf") {
    return parsePdfInWorker(bytes, options);
  }

  return { ok: false, code: "DOCUMENT_TYPE_UNSUPPORTED" };
}

function parsePlainText(bytes: Uint8Array): DocumentParserResult {
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const normalized = normalizeCanonicalPageText(decoded);

  if (normalized.length === 0) {
    return { ok: false, code: "DOCUMENT_NO_EXTRACTABLE_TEXT" };
  }

  const partialReasons: string[] = [];
  let pageText = normalized;

  if (pageText.length > DOCUMENT_LIMITS.maxCharsPerPage) {
    partialReasons.push("PAGE_CHAR_LIMIT_EXCEEDED");
    pageText = safeSliceUtf16(pageText, DOCUMENT_LIMITS.maxCharsPerPage);
  }

  if (pageText.length > DOCUMENT_LIMITS.maxTotalExtractedChars) {
    if (!partialReasons.includes("CHAR_LIMIT_EXCEEDED")) {
      partialReasons.push("CHAR_LIMIT_EXCEEDED");
    }
    pageText = safeSliceUtf16(pageText, DOCUMENT_LIMITS.maxTotalExtractedChars);
  }

  const page: ExtractedDocumentPage = {
    pageNumber: 1,
    text: pageText,
    charCount: pageText.length,
  };

  return {
    ok: true,
    pages: Object.freeze([page]),
    pagesTotal: 1,
    pagesExtracted: 1,
    charactersExtracted: pageText.length,
    partialReasons: Object.freeze(partialReasons),
    isPartial: partialReasons.length > 0,
  };
}

function resolveUnpdfUrl(): string {
  if (typeof import.meta.resolve === "function") {
    try {
      return import.meta.resolve("unpdf");
    } catch {
      // Fall through to createRequire
    }
  }
  const req = createRequire(import.meta.url);
  const resolved = req.resolve("unpdf");
  return new URL("./index.mjs", pathToFileURL(resolved)).href;
}

async function parsePdfInWorker(
  bytes: Uint8Array,
  options?: ParseDocumentOptions
): Promise<DocumentParserResult> {
  if (options?.signal?.aborted) {
    return { ok: false, code: "CANCELLED" };
  }

  let unpdfUrl: string;
  try {
    unpdfUrl = resolveUnpdfUrl();
  } catch {
    return { ok: false, code: "DOCUMENT_PARSE_FAILED" };
  }

  const timeoutMs = resolveTimeoutMs(options?.timeoutMs);

  const permit = tryAcquirePdfWorkerPermit();
  if (!permit) {
    return { ok: false, code: "DOCUMENT_PARSER_BUSY" };
  }

  try {
    if (options?.signal?.aborted) {
      return { ok: false, code: "CANCELLED" };
    }
    return await executeWorker(unpdfUrl, bytes, timeoutMs, options);
  } finally {
    permit.release();
  }
}

async function executeWorker(
  unpdfUrl: string,
  bytes: Uint8Array,
  timeoutMs: number,
  options?: ParseDocumentOptions
): Promise<DocumentParserResult> {
  const factory = options?._workerFactory ?? injectedWorkerFactory ?? ((opts) => new Worker(PDF_WORKER_SCRIPT, opts));

  let worker: WorkerLike;
  try {
    worker = factory({
      eval: true,
      workerData: {
        unpdfUrl,
        bytes,
        limits: DOCUMENT_LIMITS,
      },
      resourceLimits: DOCUMENT_LIMITS.workerResourceLimits,
    });
  } catch {
    return { ok: false, code: "DOCUMENT_PARSE_FAILED" };
  }

  return new Promise<DocumentParserResult>((resolve) => {
    let settled = false;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);

    const cleanup = async () => {
      timeoutSignal.removeEventListener("abort", onTimeout);
      if (options?.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      try {
        await worker.terminate();
      } catch {
        // Ignore termination error
      }
    };

    const finish = (result: DocumentParserResult) => {
      if (settled) return;
      settled = true;
      void cleanup().then(() => resolve(result));
    };

    const onAbort = () => {
      finish({ ok: false, code: "CANCELLED" });
    };

    const onTimeout = () => {
      finish({ ok: false, code: "DOCUMENT_PARSE_FAILED" });
    };

    if (options?.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    timeoutSignal.addEventListener("abort", onTimeout, { once: true });

    worker.on("message", (msg: unknown) => {
      finish(validateWorkerMessage(msg));
    });

    worker.on("error", () => {
      finish({ ok: false, code: "DOCUMENT_PARSE_FAILED" });
    });

    worker.on("exit", () => {
      if (!settled) {
        finish({ ok: false, code: "DOCUMENT_PARSE_FAILED" });
      }
    });
  });
}
