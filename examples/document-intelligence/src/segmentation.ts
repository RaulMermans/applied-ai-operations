import { createHash } from "node:crypto";
import type { ExtractedDocumentPage } from "@aao/integration-documents";
import type { DocumentEvidenceSpan } from "./contracts.js";
import { DOCUMENT_INTELLIGENCE_LIMITS as L, EVIDENCE_ID_PATTERN } from "./limits.js";

/**
 * Computes deterministic evidence identity over document fingerprint,
 * page number, start offset, end offset, and span text hash.
 * Output format: `ev.` + 16 lowercase hex characters.
 */
export function computeEvidenceId(
  documentFingerprint: string,
  pageNumber: number,
  startOffset: number,
  endOffset: number,
  text: string
): string {
  const textHash = createHash("sha256").update(text).digest("hex");
  const payload = `${documentFingerprint}:${pageNumber}:${startOffset}:${endOffset}:${textHash}`;
  const spanHash = createHash("sha256").update(payload).digest("hex");
  return `ev.${spanHash.slice(0, 16)}`;
}

/**
 * Adjusts a potential cut position in a string so it does not split a surrogate pair.
 * If `pos` falls right between a high surrogate (0xd800..0xdbff) and low surrogate (0xdc00..0xdfff),
 * the cut is shifted backward by 1 code unit.
 */
function adjustForSurrogate(text: string, pos: number): number {
  if (pos <= 0 || pos >= text.length) return pos;
  const prevCode = text.charCodeAt(pos - 1);
  if (prevCode >= 0xd800 && prevCode <= 0xdbff) {
    return pos - 1;
  }
  return pos;
}

/**
 * Segments canonical pages into bounded evidence spans.
 *
 * Invariants:
 * - Spans NEVER cross page boundaries.
 * - Spans NEVER split Unicode surrogate pairs.
 * - Offsets are UTF-16 code-unit offsets into canonical page text.
 * - Span text equals `page.text.slice(startOffset, endOffset)` exactly.
 * - Spans are ordered deterministically: pageNumber ASC, startOffset ASC, endOffset ASC, evidenceId ASC.
 */
export function segmentDocumentPages(
  documentId: string,
  documentFingerprint: string,
  pages: readonly ExtractedDocumentPage[]
): DocumentEvidenceSpan[] {
  const spans: DocumentEvidenceSpan[] = [];

  for (const page of pages) {
    const pageText = page.text;
    const pageLength = pageText.length;
    if (pageLength === 0) continue;

    let start = 0;
    while (start < pageLength) {
      let end = start + L.targetSpanSize;
      if (end >= pageLength) {
        end = pageLength;
      } else {
        end = adjustForSurrogate(pageText, end);
        // Ensure forward progress even in unusual edge cases
        if (end <= start) {
          end = start + 1;
        }
      }

      const text = pageText.slice(start, end);
      const evidenceId = computeEvidenceId(documentFingerprint, page.pageNumber, start, end, text);

      spans.push({
        evidenceId,
        documentId,
        pageNumber: page.pageNumber,
        startOffset: start,
        endOffset: end,
        text,
      });

      if (end >= pageLength) {
        break;
      }

      // Next span starts with overlap
      let nextStart = end - L.spanOverlap;
      nextStart = adjustForSurrogate(pageText, nextStart);
      if (nextStart <= start) {
        nextStart = start + 1;
      }
      start = nextStart;
    }
  }

  // Deterministic sort: pageNumber ASC, startOffset ASC, endOffset ASC, evidenceId ASC
  spans.sort((a, b) => {
    if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
    if (a.startOffset !== b.startOffset) return a.startOffset - b.startOffset;
    if (a.endOffset !== b.endOffset) return a.endOffset - b.endOffset;
    return a.evidenceId.localeCompare(b.evidenceId);
  });

  return spans;
}

export type SpanValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Deterministically verifies the structural integrity of every evidence span
 * against the canonical pages from which they were derived.
 */
export function validateEvidenceSpans(
  documentId: string,
  documentFingerprint: string,
  pages: readonly ExtractedDocumentPage[],
  spans: readonly DocumentEvidenceSpan[]
): SpanValidationResult {
  const pagesByNumber = new Map<number, ExtractedDocumentPage>();
  for (const p of pages) {
    if (pagesByNumber.has(p.pageNumber)) {
      return { ok: false, code: "DUPLICATE_PAGE_NUMBER", message: `Duplicate page number ${p.pageNumber}` };
    }
    pagesByNumber.set(p.pageNumber, p);
  }

  const seenEvidenceIds = new Set<string>();

  for (const span of spans) {
    if (span.documentId !== documentId) {
      return { ok: false, code: "SPAN_DOCUMENT_ID_MISMATCH", message: `Span ${span.evidenceId} documentId mismatch` };
    }

    if (!EVIDENCE_ID_PATTERN.test(span.evidenceId)) {
      return { ok: false, code: "INVALID_EVIDENCE_ID", message: `Span evidenceId ${span.evidenceId} format invalid` };
    }

    if (seenEvidenceIds.has(span.evidenceId)) {
      return { ok: false, code: "DUPLICATE_EVIDENCE_ID", message: `Duplicate evidenceId ${span.evidenceId}` };
    }
    seenEvidenceIds.add(span.evidenceId);

    const page = pagesByNumber.get(span.pageNumber);
    if (!page) {
      return { ok: false, code: "SPAN_PAGE_NOT_FOUND", message: `Span ${span.evidenceId} references non-existent page ${span.pageNumber}` };
    }

    if (span.startOffset < 0 || span.startOffset >= span.endOffset || span.endOffset > page.text.length) {
      return {
        ok: false,
        code: "INVALID_SPAN_OFFSETS",
        message: `Span ${span.evidenceId} offsets [${span.startOffset}, ${span.endOffset}] out of range for page length ${page.text.length}`,
      };
    }

    const expectedText = page.text.slice(span.startOffset, span.endOffset);
    if (span.text !== expectedText) {
      return {
        ok: false,
        code: "SPAN_TEXT_MISMATCH",
        message: `Span ${span.evidenceId} text does not match page slice exactly`,
      };
    }

    const expectedEvidenceId = computeEvidenceId(documentFingerprint, span.pageNumber, span.startOffset, span.endOffset, span.text);
    if (span.evidenceId !== expectedEvidenceId) {
      return {
        ok: false,
        code: "EVIDENCE_ID_MISMATCH",
        message: `Span evidenceId ${span.evidenceId} does not match expected ${expectedEvidenceId}`,
      };
    }
  }

  return { ok: true };
}
