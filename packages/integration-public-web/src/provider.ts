/**
 * The public-web provider port: the smallest substrate access the two
 * public-web Tools need, supplied by trusted host code. It is a narrow
 * domain port inside this integration, not an `AdapterManifest` and not a
 * new AAO adapter kind.
 *
 * A provider only answers "search this one query" and "fetch this one
 * page". AAO owns everything else: input bounds, schemas, Tool identity,
 * permission classes, retry safety, result normalization, source identity,
 * and failure semantics. A provider response is untrusted data: its fields
 * are read as plain values (`url`, `title`, `snippet`, `text`), anything
 * else is ignored, and nothing in it can grant permission, name a
 * principal, change retry behavior, approve anything, or instruct a model.
 *
 * A concrete provider (a commercial search API, a crawler, a fixture) is
 * the host's choice and lives outside this package. Network access, and so
 * safe network resolution (SSRF protection, redirects, private address
 * ranges, robots rules, rate limits, credentials), is the concrete
 * provider's responsibility: this package never performs network access.
 */
export interface PublicWebProvider {
  /** Searches one query. Called at most once per query of one Tool execution, sequentially. */
  search(request: PublicWebSearchRequest, context: PublicWebProviderContext): Promise<PublicWebSearchResponse>;
  /** Fetches one page. Called at most once per URL of one Tool execution, sequentially. */
  fetch(request: PublicWebFetchRequest, context: PublicWebProviderContext): Promise<PublicWebFetchResponse>;
}

/**
 * The trusted execution context of one provider call. `signal` is the Tool
 * Runtime's own cancellation signal for the Tool execution (a Runtime
 * attempt timeout), passed through unchanged when the Runtime supplies
 * one. There is no second cancellation mechanism.
 */
export interface PublicWebProviderContext {
  readonly signal?: AbortSignal;
}

export interface PublicWebSearchRequest {
  /** Trimmed, non-empty, at most `PUBLIC_WEB_LIMITS.maxQueryLength` characters. */
  readonly query: string;
  /** How many hits AAO will keep for this query. A provider may return more; extras are dropped. */
  readonly maxResults: number;
  /** Present when the caller restricted domains. AAO filters hits itself either way; this is a hint. */
  readonly allowedDomains?: readonly string[];
}

/** What a provider may return for one query. Read defensively: a malformed response is a normalized failure. */
export type PublicWebSearchResponse = { status: "succeeded"; hits: readonly PublicWebProviderHit[] } | { status: "failed"; reason: PublicWebProviderFailureReason };

export interface PublicWebProviderHit {
  url: string;
  title?: string;
  snippet?: string;
}

export interface PublicWebFetchRequest {
  /** The canonical http(s) URL AAO asks for. */
  readonly url: string;
  /** AAO keeps at most this many characters of page text. A provider may return more; AAO truncates. */
  readonly maxChars: number;
}

/** What a provider may return for one page: extracted plain text, never raw HTML semantics AAO relies on. */
export type PublicWebFetchResponse = { status: "succeeded"; title?: string; text: string } | { status: "failed"; reason: PublicWebProviderFailureReason };

/**
 * The bounded reasons a provider may report. A thrown error, a rejected
 * promise, or any other value is never inspected: it becomes
 * `PROVIDER_ERROR` or `MALFORMED_PROVIDER_RESPONSE`.
 */
export type PublicWebProviderFailureReason = "not_found" | "blocked" | "unavailable" | "unsupported_content";
