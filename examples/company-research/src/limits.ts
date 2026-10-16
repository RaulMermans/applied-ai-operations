/**
 * Hard bounds of the Company Research proof. Every list, string, provider
 * call, and evidence character the Workflow handles is bounded by one of
 * these numbers, so the cost of a Run is derivable before it starts:
 *
 * - model calls: exactly 2 on the success path (plan, synthesis);
 * - provider search calls: at most `maxPlanQueries` (one per query, one
 *   `public_web.search` Tool execution);
 * - provider fetch calls: at most `maxSources` (one per selected URL, one
 *   `public_web.fetch_pages` Tool execution);
 * - evidence: at most `maxSources` sources of at most `maxCharsPerSource`
 *   characters and `maxTotalEvidenceChars` in total, both in Run state and
 *   in the synthesis request.
 */
export const COMPANY_RESEARCH_LIMITS = Object.freeze({
  maxCompanyNameLength: 120,
  maxQuestions: 8,
  maxQuestionLength: 300,
  maxQuestionIdLength: 32,
  maxPlanQueries: 8,
  maxQueryLength: 200,
  maxQueryIdLength: 32,
  /** Hits kept per search query. */
  resultsPerQuery: 3,
  /** Sources selected for fetch, after deduplication, in first-seen ranking order. */
  maxSources: 20,
  maxCharsPerSource: 12_000,
  maxTotalEvidenceChars: 60_000,
  maxFindingsPerAnswer: 5,
  maxStatementLength: 500,
  maxSourceRefsPerFinding: 5,
  maxLimitationLength: 500,
  maxOverallLimitations: 5,
  planMaxOutputTokens: 1_000,
  synthesisMaxOutputTokens: 4_000,
});

/** Lowercase slug ids for questions and plan queries. */
export const SLUG_PATTERN = "^[a-z][a-z0-9_-]{0,31}$";
