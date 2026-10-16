/**
 * Hard bounds for the public-web integration Tools. Input bounds are JSON
 * Schema limits that the Tool Runtime enforces before a handler runs;
 * output bounds are applied by the handler while it normalizes provider
 * data. Every provider call is bounded by these numbers, so the provider
 * budget of one Tool execution is derivable: at most `maxQueries` search
 * calls and at most `maxUrls` fetch calls.
 */
export const PUBLIC_WEB_LIMITS = Object.freeze({
  /** `public_web.search`: queries per call, and so provider search calls per Tool execution. */
  maxQueries: 8,
  /** `public_web.search`: one query, in characters. */
  maxQueryLength: 256,
  /** `public_web.search`: hits kept per query. */
  maxResultsPerQuery: 5,
  defaultResultsPerQuery: 3,
  /** `public_web.search`: domains in `allowedDomains`. */
  maxAllowedDomains: 16,
  maxDomainLength: 253,
  /** `public_web.search`: hits per call (`maxQueries × maxResultsPerQuery`). */
  maxTotalHits: 40,
  /** `public_web.fetch_pages`: URLs per call, and so provider fetch calls per Tool execution. */
  maxUrls: 20,
  /** Any URL, in characters. */
  maxUrlLength: 2048,
  /** `public_web.fetch_pages`: `maxCharsPerPage` range and default, in UTF-16 code units. */
  maxCharsPerPage: 20_000,
  defaultMaxCharsPerPage: 20_000,
  /** `public_web.fetch_pages`: `maxTotalChars` range and default: page text returned by one call. */
  maxTotalChars: 100_000,
  defaultMaxTotalChars: 100_000,
  /** Normalized titles and snippets, in UTF-16 code units. */
  maxTitleLength: 300,
  maxSnippetLength: 1000,
});
