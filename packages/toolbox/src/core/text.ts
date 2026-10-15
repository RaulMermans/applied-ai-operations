import { defineTool, type ToolDefinition, type ToolHandlerResult } from "@aao/framework";
import { CORE_TOOL_LIMITS } from "./limits.js";

// Text Tools. Pure functions of their input: no model, network, filesystem,
// environment, clock, randomness, or locale. Lengths and offsets are
// JavaScript UTF-16 code-unit indexes (`String.prototype.length` / `slice`).

const UNICODE_FORMS = ["NFC", "NFD", "NFKC", "NFKD"] as const;
type UnicodeForm = (typeof UNICODE_FORMS)[number];

const textInput = { type: "string", maxLength: CORE_TOOL_LIMITS.maxTextLength, description: `At most ${CORE_TOOL_LIMITS.maxTextLength} characters (Unicode code points).` };

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
/** True when `index` falls between the two halves of a surrogate pair, where slicing would break a character. */
const splitsPair = (text: string, index: number) => index > 0 && index < text.length && isHighSurrogate(text.charCodeAt(index - 1)) && isLowSurrogate(text.charCodeAt(index));

// --- text.normalize ------------------------------------------------------------------

export interface TextNormalizeInput {
  text: string;
  trim?: boolean;
  trimTrailingWhitespace?: boolean;
  maxConsecutiveBlankLines?: number;
  unicodeNormalization?: UnicodeForm;
}

/** The change codes `changesApplied` may report, in application order. */
export const TEXT_NORMALIZE_CHANGES = ["unicode_nfc", "unicode_nfd", "unicode_nfkc", "unicode_nfkd", "line_endings_lf", "trailing_whitespace_trimmed", "blank_lines_collapsed", "outer_whitespace_trimmed"] as const;

/**
 * Applies, in this fixed order and only when requested (or by default):
 *
 * 1. `unicodeNormalization` (off unless a form is named): `String.prototype.normalize(form)`.
 * 2. Line endings (always): CRLF and lone CR become LF.
 * 3. `trimTrailingWhitespace` (default false): spaces and tabs at the end of each line are removed.
 * 4. `maxConsecutiveBlankLines` (off unless set): a blank line is empty or only spaces/tabs;
 *    a run longer than the limit keeps its first `limit` lines.
 * 5. `trim` (default true): `String.prototype.trim` (Unicode White_Space and line terminators) on the whole text.
 *
 * `changesApplied` lists only the steps that changed the text.
 */
export function normalizeText(input: TextNormalizeInput): ToolHandlerResult {
  let text = input.text;
  const changesApplied: string[] = [];
  const apply = (code: string, next: string) => {
    if (next !== text) changesApplied.push(code);
    text = next;
  };
  if (input.unicodeNormalization !== undefined) apply(`unicode_${input.unicodeNormalization.toLowerCase()}`, text.normalize(input.unicodeNormalization));
  apply("line_endings_lf", text.replace(/\r\n?/g, "\n"));
  if (input.trimTrailingWhitespace === true) apply("trailing_whitespace_trimmed", text.replace(/[ \t]+$/gm, ""));
  if (input.maxConsecutiveBlankLines !== undefined) {
    const limit = input.maxConsecutiveBlankLines;
    let run = 0;
    const kept = text.split("\n").filter((line) => {
      run = /^[ \t]*$/.test(line) ? run + 1 : 0;
      return run <= limit;
    });
    apply("blank_lines_collapsed", kept.join("\n"));
  }
  if (input.trim !== false) apply("outer_whitespace_trimmed", text.trim());
  if (text.length > CORE_TOOL_LIMITS.maxNormalizedTextLength) return { ok: false, code: "OUTPUT_TOO_LARGE" };
  return { ok: true, output: { status: text.length === 0 ? "empty" : "success", data: { text }, meta: { inputLength: input.text.length, outputLength: text.length, lengthUnit: "utf16", changesApplied } } };
}

export const textNormalize: ToolDefinition = defineTool({
  spec: {
    schemaVersion: 1,
    id: "text.normalize",
    version: "1.0.0",
    name: "Normalize text",
    description:
      "Deterministically normalizes supplied text: converts CRLF and CR line endings to LF, trims outer whitespace (on by default), and, only when asked, trims trailing spaces/tabs per line, caps runs of blank lines, or applies one named Unicode normalization form (NFC, NFD, NFKC, NFKD). Use it to clean text before comparing, chunking, or storing it. It never rewrites wording, case, or punctuation, and it is not a spell checker or sanitizer. Input text is at most 262,144 characters; output above 524,288 UTF-16 code units is refused (OUTPUT_TOO_LARGE). Pure computation: no side effects, no model, network, filesystem, or environment access.",
    inputSchema: {
      type: "object",
      properties: {
        text: textInput,
        trim: { type: "boolean", description: "Trim outer whitespace (String.prototype.trim). Default true." },
        trimTrailingWhitespace: { type: "boolean", description: "Remove spaces and tabs at the end of every line. Default false." },
        maxConsecutiveBlankLines: { type: "integer", minimum: 0, maximum: CORE_TOOL_LIMITS.maxConsecutiveBlankLines, description: "Keep at most this many consecutive blank lines. Default: no limit." },
        unicodeNormalization: { type: "string", enum: [...UNICODE_FORMS], description: "Apply this Unicode normalization form. Default: none." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["success", "empty"] },
        data: { type: "object", properties: { text: { type: "string", maxLength: CORE_TOOL_LIMITS.maxNormalizedTextLength } }, required: ["text"], additionalProperties: false },
        meta: {
          type: "object",
          properties: {
            inputLength: { type: "integer", minimum: 0 },
            outputLength: { type: "integer", minimum: 0 },
            lengthUnit: { type: "string", enum: ["utf16"] },
            changesApplied: { type: "array", maxItems: TEXT_NORMALIZE_CHANGES.length, items: { type: "string", enum: [...TEXT_NORMALIZE_CHANGES] } },
          },
          required: ["inputLength", "outputLength", "lengthUnit", "changesApplied"],
          additionalProperties: false,
        },
      },
      required: ["status", "data", "meta"],
      additionalProperties: false,
    },
    permissionClasses: ["read_only"],
  },
  // The handler context's toolExecutionId, tool, and signal are unused: the result depends on `input` only.
  handler: { execute: async ({ input }) => normalizeText(input as unknown as TextNormalizeInput) },
  retrySafety: "safe",
});

// --- text.chunk ----------------------------------------------------------------------

export interface TextChunkInput {
  text: string;
  maxChars: number;
  overlapChars?: number;
  maxChunks?: number;
  startOffset?: number;
}

/**
 * Character-offset chunking (never semantic, model, or tokenizer based).
 * Offsets are UTF-16 code-unit indexes, consistent with `String.prototype.slice`:
 * `chunk.text === text.slice(chunk.start, chunk.end)`. A boundary never
 * splits a surrogate pair: a chunk may end one unit early, and the next
 * start may move one unit later, so the effective overlap can be one unit
 * smaller than `overlapChars`. Each chunk starts after the previous one, so
 * the loop always progresses.
 *
 * `status` is `empty` when there is nothing at or after `startOffset`,
 * `partial` when `maxChunks` or the output bound stopped early — then
 * `meta.nextOffset` is where the next call should start (`startOffset`) —
 * and `success` when the chunks cover the text through its end. Content is
 * never silently dropped.
 */
export function chunkText(input: TextChunkInput): ToolHandlerResult {
  const { text, maxChars } = input;
  const overlapChars = input.overlapChars ?? 0;
  const maxChunks = input.maxChunks ?? CORE_TOOL_LIMITS.defaultMaxChunks;
  const startOffset = input.startOffset ?? 0;
  if (overlapChars >= maxChars) return { ok: false, code: "INVALID_CHUNK_OVERLAP" };
  if (startOffset > text.length || splitsPair(text, startOffset)) return { ok: false, code: "INVALID_START_OFFSET" };

  const chunks: { index: number; start: number; end: number; text: string }[] = [];
  let outputChars = 0;
  let partialReason: "max_chunks" | "output_limit" | null = null;
  let start = startOffset;
  while (start < text.length) {
    if (chunks.length === maxChunks) {
      partialReason = "max_chunks";
      break;
    }
    let end = Math.min(start + maxChars, text.length);
    if (splitsPair(text, end)) end -= 1;
    if (outputChars + (end - start) > CORE_TOOL_LIMITS.maxChunkOutputChars) {
      partialReason = "output_limit";
      break;
    }
    chunks.push({ index: chunks.length, start, end, text: text.slice(start, end) });
    outputChars += end - start;
    if (end === text.length) break;
    let next = Math.max(end - overlapChars, start + 1);
    if (splitsPair(text, next)) next += 1;
    start = next;
  }
  const status = partialReason !== null ? "partial" : chunks.length === 0 ? "empty" : "success";
  return {
    ok: true,
    output: { status, data: { chunks }, meta: { textLength: text.length, startOffset, maxChars, overlapChars, chunkCount: chunks.length, offsetUnit: "utf16", nextOffset: partialReason !== null ? start : null, partialReason } },
  };
}

export const textChunk: ToolDefinition = defineTool({
  spec: {
    schemaVersion: 1,
    id: "text.chunk",
    version: "1.0.0",
    name: "Chunk text by character offsets",
    description:
      "Splits supplied text into ordered, bounded chunks of at most maxChars UTF-16 code units, with an optional overlap, and returns each chunk's index, start and end offsets, and text (text.slice(start, end)). Boundaries never split a surrogate pair. Use it to prepare long text for bounded downstream steps. It is character-offset chunking only: not semantic, sentence-aware, model-based, or tokenizer-based chunking. Limits: text at most 262,144 characters, maxChars 2–20,000, overlapChars below maxChars, maxChunks 1–1,000 (default 100), 1,048,576 code units of chunk text per call. When a limit stops early the status is partial and meta.nextOffset says where to continue; content is never silently dropped. Pure computation: no side effects, no model, network, filesystem, or environment access.",
    inputSchema: {
      type: "object",
      properties: {
        text: textInput,
        maxChars: { type: "integer", minimum: CORE_TOOL_LIMITS.minChunkChars, maximum: CORE_TOOL_LIMITS.maxChunkChars, description: "Largest chunk, in UTF-16 code units." },
        overlapChars: { type: "integer", minimum: 0, maximum: CORE_TOOL_LIMITS.maxChunkChars - 1, description: "Code units shared by consecutive chunks; must be below maxChars. Default 0." },
        maxChunks: { type: "integer", minimum: 1, maximum: CORE_TOOL_LIMITS.maxChunks, description: `Most chunks to return. Default ${CORE_TOOL_LIMITS.defaultMaxChunks}.` },
        startOffset: { type: "integer", minimum: 0, maximum: 2 * CORE_TOOL_LIMITS.maxTextLength, description: "UTF-16 offset to start at (a previous partial result's meta.nextOffset). Default 0." },
      },
      required: ["text", "maxChars"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["success", "empty", "partial"] },
        data: {
          type: "object",
          properties: {
            chunks: {
              type: "array",
              maxItems: CORE_TOOL_LIMITS.maxChunks,
              items: {
                type: "object",
                properties: { index: { type: "integer", minimum: 0 }, start: { type: "integer", minimum: 0 }, end: { type: "integer", minimum: 0 }, text: { type: "string" } },
                required: ["index", "start", "end", "text"],
                additionalProperties: false,
              },
            },
          },
          required: ["chunks"],
          additionalProperties: false,
        },
        meta: {
          type: "object",
          properties: {
            textLength: { type: "integer", minimum: 0 },
            startOffset: { type: "integer", minimum: 0 },
            maxChars: { type: "integer", minimum: 1 },
            overlapChars: { type: "integer", minimum: 0 },
            chunkCount: { type: "integer", minimum: 0 },
            offsetUnit: { type: "string", enum: ["utf16"] },
            nextOffset: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
            partialReason: { anyOf: [{ type: "string", enum: ["max_chunks", "output_limit"] }, { type: "null" }] },
          },
          required: ["textLength", "startOffset", "maxChars", "overlapChars", "chunkCount", "offsetUnit", "nextOffset", "partialReason"],
          additionalProperties: false,
        },
      },
      required: ["status", "data", "meta"],
      additionalProperties: false,
    },
    permissionClasses: ["read_only"],
  },
  handler: { execute: async ({ input }) => chunkText(input as unknown as TextChunkInput) },
  retrySafety: "safe",
});
