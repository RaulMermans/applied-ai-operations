import { describe, expect, it } from "vitest";
import { CORE_TOOL_LIMITS } from "../src/index.js";
import { execute, output } from "./support.js";

interface Normalized { status: string; data: { text: string }; meta: { inputLength: number; outputLength: number; lengthUnit: string; changesApplied: string[] } }
interface Chunked { status: string; data: { chunks: { index: number; start: number; end: number; text: string }[] }; meta: { textLength: number; startOffset: number; chunkCount: number; nextOffset: number | null; partialReason: string | null; offsetUnit: string } }

const normalize = (input: Record<string, unknown>) => output<Normalized>("text.normalize", input);
const chunk = (input: Record<string, unknown>) => output<Chunked>("text.chunk", input);
const failureOf = async (id: string, input: unknown) => {
  const result = await execute(id, input);
  if (result.ok) throw new Error("expected a failure");
  return result.failure;
};

/** A high surrogate without its low half, or a low surrogate without its high half. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Every chunk is an exact slice of the source and never starts or ends inside a surrogate pair. */
function expectSoundChunks(text: string, chunks: Chunked["data"]["chunks"], maxChars: number) {
  chunks.forEach((entry, index) => {
    expect(entry.index).toBe(index);
    expect(entry.text).toBe(text.slice(entry.start, entry.end));
    expect(entry.end - entry.start).toBeGreaterThan(0);
    expect(entry.end - entry.start).toBeLessThanOrEqual(maxChars);
    expect(entry.text).not.toMatch(LONE_SURROGATE);
    if (index > 0) expect(entry.start).toBeGreaterThan(chunks[index - 1]!.start);
  });
}

describe("text.normalize", () => {
  it("empty text: status empty, nothing changed", async () => {
    expect(await normalize({ text: "" })).toEqual({ status: "empty", data: { text: "" }, meta: { inputLength: 0, outputLength: 0, lengthUnit: "utf16", changesApplied: [] } });
  });

  it("whitespace-only text trims to empty", async () => {
    expect(await normalize({ text: " \r\n\t " })).toMatchObject({ status: "empty", data: { text: "" }, meta: { changesApplied: ["line_endings_lf", "outer_whitespace_trimmed"] } });
  });

  it("normal text: CRLF and lone CR become LF; outer whitespace is trimmed by default; inner text is untouched", async () => {
    const result = await normalize({ text: "  Hello,\r\nWorld!\rBye  " });
    expect(result.data.text).toBe("Hello,\nWorld!\nBye");
    expect(result.meta).toEqual({ inputLength: 22, outputLength: 17, lengthUnit: "utf16", changesApplied: ["line_endings_lf", "outer_whitespace_trimmed"] });
  });

  it("trim: false keeps outer whitespace; nothing aggressive happens without being asked", async () => {
    expect((await normalize({ text: "  Mixed CASE,  spacing.  ", trim: false })).data.text).toBe("  Mixed CASE,  spacing.  ");
    expect((await normalize({ text: "a  \nb\t\n\n\n\nc" })).data.text).toBe("a  \nb\t\n\n\n\nc");
  });

  it("trailing whitespace and blank-line runs change only when requested, in the documented order", async () => {
    const result = await normalize({ text: "a  \r\n\r\n \t\r\n\r\nb\t\r\n", trimTrailingWhitespace: true, maxConsecutiveBlankLines: 1 });
    expect(result.data.text).toBe("a\n\nb");
    expect(result.meta.changesApplied).toEqual(["line_endings_lf", "trailing_whitespace_trimmed", "blank_lines_collapsed", "outer_whitespace_trimmed"]);
    expect((await normalize({ text: "a\n\n\n\nb", maxConsecutiveBlankLines: 0 })).data.text).toBe("a\nb");
    expect((await normalize({ text: "a\n\n\n\nb", maxConsecutiveBlankLines: 2 })).data.text).toBe("a\n\n\nb");
  });

  it("Unicode is preserved unless a normalization form is named explicitly", async () => {
    const decomposed = "Café 👋🏽 東京";
    expect((await normalize({ text: decomposed })).data.text).toBe(decomposed);
    const nfc = await normalize({ text: decomposed, unicodeNormalization: "NFC" });
    expect(nfc.data.text).toBe("Café 👋🏽 東京");
    expect(nfc.meta.changesApplied).toEqual(["unicode_nfc"]);
    expect((await normalize({ text: "ﬁ", unicodeNormalization: "NFKC" })).data.text).toBe("fi");
    expect((await normalize({ text: "Café", unicodeNormalization: "NFD" })).data.text).toBe("Café");
  });

  it("maximum size is accepted; one over is a schema failure before the handler", async () => {
    const max = "x".repeat(CORE_TOOL_LIMITS.maxTextLength);
    expect((await normalize({ text: max })).meta.outputLength).toBe(CORE_TOOL_LIMITS.maxTextLength);
    expect((await failureOf("text.normalize", { text: `${max}x` })).code).toBe("TOOL_INPUT_SCHEMA_MISMATCH");
  });

  it("expanding compatibility normalization beyond the output bound is refused, never truncated", async () => {
    // U+FDFA expands to 18 code units under NFKC.
    const failure = await failureOf("text.normalize", { text: "ﷺ".repeat(30_000), unicodeNormalization: "NFKC" });
    expect(failure).toMatchObject({ code: "TOOL_EXECUTION_FAILED", handlerFailureCode: "OUTPUT_TOO_LARGE" });
  });

  it("rejects unknown options and invalid values through the input schema", async () => {
    for (const input of [{ text: "a", lowercase: true }, { text: "a", unicodeNormalization: "nfc" }, { text: "a", maxConsecutiveBlankLines: 11 }, { text: 1 }, {}]) {
      expect((await failureOf("text.normalize", input)).code).toBe("TOOL_INPUT_SCHEMA_MISMATCH");
    }
  });

  it("is deterministic: repeated calls are deep-equal", async () => {
    const input = { text: " Café\r\n\r\n\r\nx ", unicodeNormalization: "NFC", maxConsecutiveBlankLines: 1 };
    const first = await normalize(input);
    for (let i = 0; i < 5; i += 1) expect(await normalize(input)).toEqual(first);
  });
});

describe("text.chunk", () => {
  it("empty text: status empty, no chunks", async () => {
    expect(await chunk({ text: "", maxChars: 4 })).toEqual({ status: "empty", data: { chunks: [] }, meta: { textLength: 0, startOffset: 0, maxChars: 4, overlapChars: 0, chunkCount: 0, offsetUnit: "utf16", nextOffset: null, partialReason: null } });
  });

  it("ASCII without overlap: contiguous chunks covering the text", async () => {
    const result = await chunk({ text: "abcdefghij", maxChars: 4 });
    expect(result.status).toBe("success");
    expect(result.data.chunks).toEqual([
      { index: 0, start: 0, end: 4, text: "abcd" },
      { index: 1, start: 4, end: 8, text: "efgh" },
      { index: 2, start: 8, end: 10, text: "ij" },
    ]);
  });

  it("exact boundary: a text of exactly k × maxChars yields k full chunks and no empty tail", async () => {
    const result = await chunk({ text: "abcdefgh", maxChars: 4 });
    expect(result.data.chunks.map((entry) => entry.text)).toEqual(["abcd", "efgh"]);
    expect((await chunk({ text: "abcd", maxChars: 4 })).data.chunks).toEqual([{ index: 0, start: 0, end: 4, text: "abcd" }]);
  });

  it("overlap: consecutive chunks share overlapChars code units", async () => {
    const result = await chunk({ text: "abcdefghij", maxChars: 4, overlapChars: 2 });
    expect(result.data.chunks.map((entry) => [entry.start, entry.end, entry.text])).toEqual([[0, 4, "abcd"], [2, 6, "cdef"], [4, 8, "efgh"], [6, 10, "ghij"]]);
    expectSoundChunks("abcdefghij", result.data.chunks, 4);
  });

  it("multiline text keeps its newlines inside chunks", async () => {
    const text = "line one\nline two\r\nline three";
    const result = await chunk({ text, maxChars: 10 });
    expect(result.data.chunks.map((entry) => entry.text).join("")).toBe(text);
    expectSoundChunks(text, result.data.chunks, 10);
  });

  it("emoji and surrogate pairs are never split; offsets are UTF-16 indexes consistent with slice", async () => {
    const text = "a😀b😀😀c";
    expect(text.length).toBe(9);
    const result = await chunk({ text, maxChars: 2 });
    expectSoundChunks(text, result.data.chunks, 2);
    expect(result.data.chunks.map((entry) => entry.text)).toEqual(["a", "😀", "b", "😀", "😀", "c"]);
    expect(result.data.chunks.map((entry) => entry.text).join("")).toBe(text);
    const overlapped = await chunk({ text: "😀😀😀😀", maxChars: 3, overlapChars: 2 });
    expectSoundChunks("😀😀😀😀", overlapped.data.chunks, 3);
    expect(overlapped.status).toBe("success");
    expect(overlapped.data.chunks.at(-1)!.end).toBe(8);
  });

  it("maxChunks: an early stop is explicit — status partial with continuation metadata — and continuing covers the rest", async () => {
    const text = "abcdefghijklmn";
    const first = await chunk({ text, maxChars: 3, maxChunks: 2 });
    expect(first).toMatchObject({ status: "partial", meta: { chunkCount: 2, nextOffset: 6, partialReason: "max_chunks" } });
    const rest = await chunk({ text, maxChars: 3, maxChunks: 2, startOffset: first.meta.nextOffset! });
    expect(rest).toMatchObject({ status: "partial", meta: { startOffset: 6, nextOffset: 12 } });
    expect(rest.data.chunks.map((entry) => [entry.index, entry.start, entry.end])).toEqual([[0, 6, 9], [1, 9, 12]]);
    const last = await chunk({ text, maxChars: 3, maxChunks: 2, startOffset: rest.meta.nextOffset! });
    expect(last).toMatchObject({ status: "success", meta: { nextOffset: null, partialReason: null } });
    expect([...first.data.chunks, ...rest.data.chunks, ...last.data.chunks].map((entry) => entry.text).join("")).toBe(text);
    expect(await chunk({ text, maxChars: 3, startOffset: text.length })).toMatchObject({ status: "empty", data: { chunks: [] } });
  });

  it("the output bound stops early with partial, never silent truncation", async () => {
    // 262,144 units with a heavy overlap would emit far more than 1,048,576 units of chunk text.
    const text = "x".repeat(CORE_TOOL_LIMITS.maxTextLength);
    const result = await chunk({ text, maxChars: 20_000, overlapChars: 19_000, maxChunks: 1000 });
    expect(result).toMatchObject({ status: "partial", meta: { partialReason: "output_limit" } });
    const emitted = result.data.chunks.reduce((total, entry) => total + entry.text.length, 0);
    expect(emitted).toBeLessThanOrEqual(CORE_TOOL_LIMITS.maxChunkOutputChars);
    expect(result.meta.nextOffset).toBe(result.data.chunks.at(-1)!.end - 19_000);
  });

  it("invalid overlap (≥ maxChars) and invalid start offsets fail deterministically before any chunk is produced", async () => {
    expect(await failureOf("text.chunk", { text: "abc", maxChars: 4, overlapChars: 4 })).toMatchObject({ code: "TOOL_EXECUTION_FAILED", handlerFailureCode: "INVALID_CHUNK_OVERLAP" });
    expect(await failureOf("text.chunk", { text: "abc", maxChars: 4, overlapChars: 9 })).toMatchObject({ handlerFailureCode: "INVALID_CHUNK_OVERLAP" });
    expect(await failureOf("text.chunk", { text: "abc", maxChars: 4, startOffset: 4 })).toMatchObject({ handlerFailureCode: "INVALID_START_OFFSET" });
    expect(await failureOf("text.chunk", { text: "a😀", maxChars: 4, startOffset: 2 })).toMatchObject({ handlerFailureCode: "INVALID_START_OFFSET" });
  });

  it("bounds on maxChars and maxChunks are input-schema failures", async () => {
    for (const input of [{ text: "a", maxChars: 1 }, { text: "a", maxChars: 20_001 }, { text: "a", maxChars: 4, maxChunks: 0 }, { text: "a", maxChars: 4, maxChunks: 1001 }, { text: "a" }, { text: "a", maxChars: 4.5 }]) {
      expect((await failureOf("text.chunk", input)).code).toBe("TOOL_INPUT_SCHEMA_MISMATCH");
    }
  });

  it("is deterministic: repeated calls are deep-equal", async () => {
    const input = { text: "Determinism 😀 matters.\n".repeat(40), maxChars: 50, overlapChars: 7, maxChunks: 10 };
    const first = await chunk(input);
    for (let i = 0; i < 5; i += 1) expect(await chunk(input)).toEqual(first);
  });
});
