/**
 * Bounded document resource limits for @aao/integration-documents (Sprint 23, ADR-028).
 * Every input and extracted document size is bounded deterministically to prevent memory
 * exhaustion, parser stalling, or unbounded state inflation.
 */
export const DOCUMENT_LIMITS = Object.freeze({
  /** Hard bound on raw source bytes returned by DocumentSourceProvider: 10 MiB. */
  maxDocumentBytes: 10 * 1024 * 1024,
  /** Maximum number of document pages extracted before marking extraction partial: 100 pages. */
  maxPagesTotal: 100,
  /** Maximum canonical UTF-16 code units per page: 50,000 characters. */
  maxCharsPerPage: 50_000,
  /** Maximum total canonical UTF-16 code units extracted from a document: 200,000 characters. */
  maxTotalExtractedChars: 200_000,
  /** Maximum length of an opaque documentRef string. */
  maxDocumentRefLength: 256,
  /** Maximum length of an optional host-provided filename. */
  maxFilenameLength: 256,
  /** Maximum length of a MIME type string. */
  maxMimeTypeLength: 128,
  /** Process-wide maximum number of active PDF worker threads (Sprint 23D). */
  maxConcurrentPdfWorkers: 2,
  /** Default worker execution timeout in milliseconds. */
  defaultParserTimeoutMs: 15_000,
  /**
   * Per-worker V8 resource limits (Sprint 23D).
   * Constrains V8-managed heap and stack allocations per worker.
   * Note: This bounds V8 JS heap/stack, not external ArrayBuffers or native allocations (deferred to Sprint 29).
   */
  workerResourceLimits: Object.freeze({
    maxOldGenerationSizeMb: 128,
    maxYoungGenerationSizeMb: 32,
    stackSizeMb: 4,
  }),
});
