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
        | "CANCELLED";
    };

export interface ParseDocumentOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

const DEFAULT_PARSER_TIMEOUT_MS = 15_000;

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

  const unpdfUrl = resolveUnpdfUrl();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_PARSER_TIMEOUT_MS;

  return new Promise<DocumentParserResult>((resolve) => {
    let settled = false;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);

    const worker = new Worker(PDF_WORKER_SCRIPT, {
      eval: true,
      workerData: {
        unpdfUrl,
        bytes,
        limits: DOCUMENT_LIMITS,
      },
    });

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
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    timeoutSignal.addEventListener("abort", onTimeout, { once: true });

    worker.on("message", (msg: unknown) => {
      if (
        msg !== null &&
        typeof msg === "object" &&
        "ok" in msg
      ) {
        const res = msg as DocumentParserResult;
        if (res.ok) {
          finish({
            ok: true,
            pages: Object.freeze(res.pages),
            pagesTotal: res.pagesTotal,
            pagesExtracted: res.pagesExtracted,
            charactersExtracted: res.charactersExtracted,
            partialReasons: Object.freeze([...res.partialReasons]),
            isPartial: res.isPartial,
          });
          return;
        }
        if (!res.ok && typeof res.code === "string") {
          finish({ ok: false, code: res.code });
          return;
        }
      }
      finish({ ok: false, code: "DOCUMENT_PARSE_FAILED" });
    });

    worker.on("error", () => {
      finish({ ok: false, code: "DOCUMENT_PARSE_FAILED" });
    });

    worker.on("exit", (code) => {
      if (!settled) {
        finish({ ok: false, code: code === 0 ? "DOCUMENT_NO_EXTRACTABLE_TEXT" : "DOCUMENT_PARSE_FAILED" });
      }
    });
  });
}
