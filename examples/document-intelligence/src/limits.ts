/**
 * Exact resource bounds for the Document Intelligence proof application (Sprint 23, ADR-028).
 * Ensures deterministic resource utilization, bounded context window sizing, and clean validation.
 */
export const DOCUMENT_INTELLIGENCE_LIMITS = Object.freeze({
  /** Minimum number of questions per request. */
  minQuestions: 1,
  /** Maximum number of questions per request: 1–8. */
  maxQuestions: 8,
  /** Maximum character length of a question: 300 UTF-16 units. */
  maxQuestionLength: 300,
  /** Maximum length of a question identifier slug. */
  maxQuestionIdLength: 64,
  /** Maximum length of the opaque document reference. */
  maxDocumentRefLength: 256,

  /** Target UTF-16 code units per evidence span: 1,500. */
  targetSpanSize: 1500,
  /** Overlap between consecutive spans on the same page: 200 UTF-16 units. */
  spanOverlap: 200,

  /** Maximum evidence spans admitted to model context: 60. */
  maxAdmittedSpans: 60,
  /** Hard cap on total evidence characters admitted to model context: 60,000 UTF-16 units. */
  maxTotalEvidenceChars: 60_000,

  /** Maximum findings per answered question: 5. */
  maxFindingsPerAnswer: 5,
  /** Maximum length of a finding statement: 500 UTF-16 units. */
  maxStatementLength: 500,
  /** Minimum evidence references cited per finding: 1. */
  minEvidenceRefsPerFinding: 1,
  /** Maximum evidence references cited per finding: 5. */
  maxEvidenceRefsPerFinding: 5,
  /** Maximum limitation explanations per answer or overall: 5. */
  maxOverallLimitations: 5,
  /** Maximum length of a limitation statement: 300 UTF-16 units. */
  maxLimitationLength: 300,

  /** Maximum length of an excerpt displayed in the final evidence index: 300 UTF-16 units. */
  maxExcerptLength: 300,

  /** Maximum tokens for model structured synthesis. */
  synthesisMaxOutputTokens: 2000,
});

/** Question slug identifier pattern (1–64 characters, lowercase alphanumeric with dashes or underscores). */
export const QUESTION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Evidence ID pattern: `ev.` followed by 16 hex characters. */
export const EVIDENCE_ID_PATTERN = /^ev\.[a-f0-9]{16}$/;
