// Node 20 compatibility: polyfill minimal global Iterator if missing (added natively in Node 22)
if (typeof (globalThis as unknown as { Iterator?: unknown }).Iterator === "undefined") {
  (globalThis as unknown as { Iterator: unknown }).Iterator = class Iterator {};
}

import { getDocumentProxy } from "unpdf";
import { DOCUMENT_LIMITS } from "./limits.js";
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
        | "DOCUMENT_NO_EXTRACTABLE_TEXT";
    };

/**
 * Parses raw document bytes according to its MIME type into canonical pages.
 * Supports only `application/pdf` and `text/plain`.
 * Returns normalized failures for unsupported types, corrupt PDFs, or documents with no extractable text.
 */
export async function parseDocumentBytes(bytes: Uint8Array, mimeType: string): Promise<DocumentParserResult> {
  const normalizedMime = mimeType.trim().toLowerCase();

  if (normalizedMime === "text/plain") {
    return parsePlainText(bytes);
  }

  if (normalizedMime === "application/pdf") {
    return parsePdf(bytes);
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

async function parsePdf(bytes: Uint8Array): Promise<DocumentParserResult> {
  let doc: { numPages: number; getPage(pageNumber: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>; destroy?: () => Promise<void> } | undefined;

  // Defensive copy so caller's buffer is never detached or mutated by PDF.js internal transfer
  const safeBytes = new Uint8Array(bytes);

  try {
    doc = (await getDocumentProxy(safeBytes, {
      verbosity: 0,
      disableFontFace: true,
      disableAutoFetch: true,
      disableStream: true,
    })) as unknown as typeof doc;
  } catch {
    return { ok: false, code: "DOCUMENT_PARSE_FAILED" };
  }

  if (!doc || doc.numPages <= 0) {
    return { ok: false, code: "DOCUMENT_NO_EXTRACTABLE_TEXT" };
  }

  const activeDoc = doc;

  try {
    const numPages = activeDoc.numPages;
    const partialReasons: string[] = [];
    const pagesToExtract = Math.min(numPages, DOCUMENT_LIMITS.maxPagesTotal);
    if (numPages > DOCUMENT_LIMITS.maxPagesTotal) {
      partialReasons.push("PAGE_LIMIT_EXCEEDED");
    }

    const pages: ExtractedDocumentPage[] = [];
    let remainingCharBudget = DOCUMENT_LIMITS.maxTotalExtractedChars;

    for (let pageNumber = 1; pageNumber <= pagesToExtract; pageNumber++) {
      let pageText = "";
      try {
        const page = await activeDoc.getPage(pageNumber);
        const textContent = await page.getTextContent();
        const raw = textContent.items
          .filter((item): item is { str: string; hasEOL?: boolean } => item !== null && typeof item === "object" && "str" in item && typeof (item as { str: unknown }).str === "string")
          .map((item) => item.str + (item.hasEOL ? "\n" : ""))
          .join("");
        pageText = normalizeCanonicalPageText(raw);
      } catch {
        // A corrupted page inside the PDF
        return { ok: false, code: "DOCUMENT_PARSE_FAILED" };
      }

      if (pageText.length > DOCUMENT_LIMITS.maxCharsPerPage) {
        if (!partialReasons.includes("PAGE_CHAR_LIMIT_EXCEEDED")) {
          partialReasons.push("PAGE_CHAR_LIMIT_EXCEEDED");
        }
        pageText = safeSliceUtf16(pageText, DOCUMENT_LIMITS.maxCharsPerPage);
      }

      if (remainingCharBudget <= 0) {
        if (!partialReasons.includes("CHAR_LIMIT_EXCEEDED")) {
          partialReasons.push("CHAR_LIMIT_EXCEEDED");
        }
        pageText = "";
      } else if (pageText.length > remainingCharBudget) {
        if (!partialReasons.includes("CHAR_LIMIT_EXCEEDED")) {
          partialReasons.push("CHAR_LIMIT_EXCEEDED");
        }
        pageText = safeSliceUtf16(pageText, remainingCharBudget);
      }

      remainingCharBudget -= pageText.length;

      pages.push({
        pageNumber,
        text: pageText,
        charCount: pageText.length,
      });
    }

    const totalExtractedChars = pages.reduce((sum, p) => sum + p.charCount, 0);
    if (totalExtractedChars === 0) {
      return { ok: false, code: "DOCUMENT_NO_EXTRACTABLE_TEXT" };
    }

    return {
      ok: true,
      pages: Object.freeze(pages),
      pagesTotal: numPages,
      pagesExtracted: pages.length,
      charactersExtracted: totalExtractedChars,
      partialReasons: Object.freeze(partialReasons),
      isPartial: partialReasons.length > 0,
    };
  } finally {
    try {
      await doc?.destroy?.();
    } catch {
      // Ignore cleanup error
    }
  }
}
