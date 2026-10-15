/**
 * Hard resource bounds for the AAO Core Toolbox Tools. Schema limits are
 * enforced by the Tool Runtime's input validation before a handler runs;
 * the rest are checked by the handler before any work and fail with a
 * bounded handler failure code. Nothing is ever silently truncated: an
 * output that would exceed a bound is refused or returned with
 * `status: "partial"` and explicit continuation metadata.
 */
export const CORE_TOOL_LIMITS = Object.freeze({
  /** `text` inputs: JSON Schema `maxLength`, which counts Unicode code points. */
  maxTextLength: 262_144,
  /** `text.normalize` output, in UTF-16 code units (compatibility normalization can expand text). */
  maxNormalizedTextLength: 524_288,
  /** `text.normalize`: the largest `maxConsecutiveBlankLines`. */
  maxConsecutiveBlankLines: 10,
  /** `text.chunk`: `maxChars` range, in UTF-16 code units. At least 2, so a surrogate pair always fits. */
  minChunkChars: 2,
  maxChunkChars: 20_000,
  /** `text.chunk`: `maxChunks` range and default. */
  maxChunks: 1000,
  defaultMaxChunks: 100,
  /** `text.chunk`: total chunk text per call, in UTF-16 code units; beyond it the result is `partial`. */
  maxChunkOutputChars: 1_048_576,
  /** `records.*`: records per call. */
  maxRecords: 1000,
  /** `records.*`: top-level fields per record. */
  maxFieldsPerRecord: 256,
  /** `records.*`: length of one field name. */
  maxFieldNameLength: 128,
  /** `records.dedupe` / `records.project`: selected fields. */
  maxSelectedFields: 64,
  /** `records.sort`: sort keys. */
  maxSortKeys: 3,
  /** `records.*`: `JSON.stringify(records).length`, in UTF-16 code units. */
  maxRecordsSerializedLength: 1_048_576,
});
