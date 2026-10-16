import { describe, expect, it } from "vitest";
import {
  computeEvidenceId,
  segmentDocumentPages,
  validateEvidenceSpans,
} from "../src/index.js";

describe("document segmentation and evidence provenance", () => {
  const docId = "doc.1111111111111111";
  const fingerprint = "1111111111111111222222222222222233333333333333334444444444444444";

  it("spans never cross page boundaries and exactly reconstruct page text slices", () => {
    const pages = [
      { pageNumber: 1, text: "Page 1 intro. Section A fees. Details about billing.", charCount: 52 },
      { pageNumber: 2, text: "Page 2 legal. Delaware law applies. Dispute resolution.", charCount: 56 },
    ];

    const spans = segmentDocumentPages(docId, fingerprint, pages);
    expect(spans.length).toBeGreaterThanOrEqual(2);

    for (const span of spans) {
      expect(span.documentId).toBe(docId);
      expect(span.evidenceId).toMatch(/^ev\.[a-f0-9]{16}$/);
      const page = pages.find((p) => p.pageNumber === span.pageNumber);
      expect(page).toBeDefined();
      expect(page!.text.slice(span.startOffset, span.endOffset)).toBe(span.text);
    }

    const check = validateEvidenceSpans(docId, fingerprint, pages, spans);
    expect(check.ok).toBe(true);
  });

  it("never splits Unicode surrogate pairs", () => {
    // Emojis: each is 2 UTF-16 code units (surrogate pair)
    // 🔏 is \uD83D\uDD12
    const emojiText = "Secret: " + "🔏".repeat(2000);
    const pages = [{ pageNumber: 1, text: emojiText, charCount: emojiText.length }];

    const spans = segmentDocumentPages(docId, fingerprint, pages);
    expect(spans.length).toBeGreaterThan(1);

    for (const span of spans) {
      // Check that span text doesn't end with high surrogate or start with low surrogate
      const firstCode = span.text.charCodeAt(0);
      const lastCode = span.text.charCodeAt(span.text.length - 1);
      expect(firstCode >= 0xdc00 && firstCode <= 0xdfff).toBe(false); // not lone low surrogate
      expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false); // not lone high surrogate

      // Offsets slice exact text
      expect(emojiText.slice(span.startOffset, span.endOffset)).toBe(span.text);
    }
  });

  it("evidence ID is deterministic and changes if any component changes", () => {
    const id1 = computeEvidenceId(fingerprint, 1, 0, 50, "hello world");
    const id2 = computeEvidenceId(fingerprint, 1, 0, 50, "hello world");
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^ev\.[a-f0-9]{16}$/);

    const diffPage = computeEvidenceId(fingerprint, 2, 0, 50, "hello world");
    expect(diffPage).not.toBe(id1);

    const diffOffset = computeEvidenceId(fingerprint, 1, 10, 60, "hello world");
    expect(diffOffset).not.toBe(id1);

    const diffText = computeEvidenceId(fingerprint, 1, 0, 50, "hello earth");
    expect(diffText).not.toBe(id1);

    const diffFp = computeEvidenceId("2222222222222222222222222222222222222222222222222222222222222222", 1, 0, 50, "hello world");
    expect(diffFp).not.toBe(id1);
  });

  it("validateEvidenceSpans detects invalid span configurations", () => {
    const pages = [{ pageNumber: 1, text: "Page 1 contents for testing.", charCount: 29 }];
    const valid = segmentDocumentPages(docId, fingerprint, pages);

    // Mismatched text slice
    const tamperedText = valid.map((s) => ({ ...s, text: "tampered" }));
    expect(validateEvidenceSpans(docId, fingerprint, pages, tamperedText).ok).toBe(false);

    // Invalid page number
    const tamperedPage = valid.map((s) => ({ ...s, pageNumber: 99 }));
    expect(validateEvidenceSpans(docId, fingerprint, pages, tamperedPage).ok).toBe(false);

    // Out of bounds offset
    const tamperedOffset = valid.map((s) => ({ ...s, endOffset: 999 }));
    expect(validateEvidenceSpans(docId, fingerprint, pages, tamperedOffset).ok).toBe(false);

    // Inverted offsets
    const invertedOffset = valid.map((s) => ({ ...s, startOffset: 20, endOffset: 10 }));
    expect(validateEvidenceSpans(docId, fingerprint, pages, invertedOffset).ok).toBe(false);
  });
});
