import { isMainThread, parentPort } from "node:worker_threads";
import type {} from "unpdf";

// Guard: Worker bootstrap compatibility shim.
// This executes ONLY inside an isolated worker thread and is guaranteed never to run in the host process.
if (!isMainThread && parentPort) {
  if (typeof (globalThis as unknown as { Iterator?: unknown }).Iterator === "undefined") {
    (globalThis as unknown as { Iterator: unknown }).Iterator = class Iterator {};
  }
}

/**
 * Isolated PDF Parser Worker Script.
 *
 * Runs exclusively inside a dedicated Node worker thread (isolated V8 context).
 * Stubs required by Mozilla PDF.js (such as global Iterator in Node 20, DOMMatrix, navigator)
 * live strictly within this thread and never leak to or mutate the host application.
 */
export const PDF_WORKER_SCRIPT = `
import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) {
  throw new Error("Worker must be spawned with parentPort");
}

// Node 20 compatibility: polyfill minimal global Iterator if missing in Node 20 (standard in Node 22+).
// This shim is strictly isolated inside this worker thread and does not mutate host globals.
if (typeof globalThis.Iterator === "undefined") {
  globalThis.Iterator = class Iterator {};
}

function safeSliceUtf16(text, maxUnits) {
  if (text.length <= maxUnits) return text;
  let cut = maxUnits;
  const lastCode = text.charCodeAt(cut - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    cut -= 1;
  }
  return text.slice(0, cut);
}

function normalizeCanonicalPageText(text) {
  return text
    .replace(/\\r\\n/g, "\\n")
    .replace(/\\r/g, "\\n")
    .replace(/\\0/g, "");
}

async function run() {
  try {
    const { unpdfUrl, bytes, limits } = workerData;
    const { getDocumentProxy } = await import(unpdfUrl);

    // Defensive copy so caller's buffer is never detached or mutated by PDF.js internal transfer
    const safeBytes = new Uint8Array(bytes);

    let doc;
    try {
      doc = await getDocumentProxy(safeBytes, {
        verbosity: 0,
        disableFontFace: true,
        disableAutoFetch: true,
        disableStream: true,
      });
    } catch {
      parentPort.postMessage({ ok: false, code: "DOCUMENT_PARSE_FAILED" });
      return;
    }

    if (!doc || doc.numPages <= 0) {
      parentPort.postMessage({ ok: false, code: "DOCUMENT_NO_EXTRACTABLE_TEXT" });
      return;
    }

    try {
      const numPages = doc.numPages;
      const partialReasons = [];
      const pagesToExtract = Math.min(numPages, limits.maxPagesTotal);
      if (numPages > limits.maxPagesTotal) {
        partialReasons.push("PAGE_LIMIT_EXCEEDED");
      }

      const pages = [];
      let remainingCharBudget = limits.maxTotalExtractedChars;

      for (let pageNumber = 1; pageNumber <= pagesToExtract; pageNumber++) {
        let pageText = "";
        try {
          const page = await doc.getPage(pageNumber);
          const textContent = await page.getTextContent();
          const raw = textContent.items
            .filter((item) => item !== null && typeof item === "object" && "str" in item && typeof item.str === "string")
            .map((item) => item.str + (item.hasEOL ? "\\n" : ""))
            .join("");
          pageText = normalizeCanonicalPageText(raw);
        } catch {
          parentPort.postMessage({ ok: false, code: "DOCUMENT_PARSE_FAILED" });
          return;
        }

        if (pageText.length > limits.maxCharsPerPage) {
          if (!partialReasons.includes("PAGE_CHAR_LIMIT_EXCEEDED")) {
            partialReasons.push("PAGE_CHAR_LIMIT_EXCEEDED");
          }
          pageText = safeSliceUtf16(pageText, limits.maxCharsPerPage);
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
        parentPort.postMessage({ ok: false, code: "DOCUMENT_NO_EXTRACTABLE_TEXT" });
        return;
      }

      parentPort.postMessage({
        ok: true,
        pages,
        pagesTotal: numPages,
        pagesExtracted: pages.length,
        charactersExtracted: totalExtractedChars,
        partialReasons,
        isPartial: partialReasons.length > 0,
      });
    } finally {
      try {
        await doc?.destroy?.();
      } catch {
        // Ignore cleanup error
      }
    }
  } catch {
    parentPort.postMessage({ ok: false, code: "DOCUMENT_PARSE_FAILED" });
  }
}

run();
`;
