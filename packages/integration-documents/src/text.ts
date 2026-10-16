/**
 * Canonical page text normalization and UTF-16 offset handling (Sprint 23, ADR-028).
 *
 * Offset Semantics:
 * All document offsets in AAO are JavaScript UTF-16 code-unit offsets into canonical page text.
 * This guarantees that `page.text.slice(startOffset, endOffset)` reconstructs the exact
 * evidence span identically across all JavaScript/TypeScript runtimes without encoding ambiguity.
 *
 * Normalization Rules:
 * - CRLF (`\r\n`) -> LF (`\n`)
 * - CR (`\r`) -> LF (`\n`)
 * - Remove NUL characters (`\0`)
 * - Do NOT rewrite whitespace aggressively, collapse multiple spaces, or reorder paragraphs.
 */

/**
 * Normalizes page text into canonical document text.
 * Performs only deterministic line ending unification and NUL removal.
 */
export function normalizeCanonicalPageText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\0/g, "");
}

/**
 * Safely slices a string at a maximum UTF-16 code unit boundary without
 * splitting a Unicode surrogate pair.
 */
export function safeSliceUtf16(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  let cut = maxUnits;
  const lastCode = text.charCodeAt(cut - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    cut -= 1;
  }
  return text.slice(0, cut);
}
