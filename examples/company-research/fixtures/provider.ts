import type { PublicWebFetchRequest, PublicWebFetchResponse, PublicWebProvider, PublicWebProviderContext, PublicWebSearchRequest, PublicWebSearchResponse } from "@aao/integration-public-web";
import { SEARCH_INDEX, SECRET, pageByUrl } from "./corpus.js";

/**
 * Deterministic fixture providers for tests, Eval evidence, the compiled
 * smoke, and the proof command. They never touch the network. Two
 * implementations return semantically equivalent data in different
 * shapes, to prove provider injection does not change Workflow semantics:
 *
 * - `a`: plain objects, exactly the canonical URLs and titles;
 * - `b`: a class with extra provider metadata on every response (ids,
 *   scores, permission claims), uppercase hosts, fragments, padded
 *   whitespace in titles, and more hits than requested.
 *
 * Scenario knobs inject failures: failing queries, failing URLs, empty
 * search, an oversized page, and seeded secrets in errors.
 */
export interface FixtureProviderOptions {
  variant?: "a" | "b";
  /** Queries containing any of these substrings throw (with a seeded secret in the error). */
  failQueriesMatching?: readonly string[];
  /** Every search returns zero hits. */
  emptySearch?: boolean;
  /** These canonical URLs fail to fetch. */
  failUrls?: readonly string[];
  /** These canonical URLs return this many characters of text. */
  oversizedUrls?: readonly string[];
  oversizedChars?: number;
  /** Every search call fails (an outage). */
  searchOutage?: boolean;
}

export interface FixtureProvider extends PublicWebProvider {
  readonly calls: { search: string[]; fetch: string[] };
}

function searchHits(query: string, maxResults: number): string[] {
  const lower = query.toLowerCase();
  const entry = SEARCH_INDEX.find((candidate) => lower.includes(candidate.match));
  // The full ranked list, whatever maxResults says: AAO bounds hits itself.
  void maxResults;
  return entry ? [...entry.urls] : [];
}

const titleOf = (url: string) => pageByUrl(url.split("#")[0]!)?.title ?? url;

export function createFixtureProvider(options: FixtureProviderOptions = {}): FixtureProvider {
  const calls = { search: [] as string[], fetch: [] as string[] };
  const variant = options.variant ?? "a";

  function search(request: PublicWebSearchRequest): PublicWebSearchResponse {
    calls.search.push(request.query);
    if (options.searchOutage) throw new Error(`search backend unavailable token=${SECRET}`);
    if (options.failQueriesMatching?.some((fragment) => request.query.toLowerCase().includes(fragment))) throw new Error(`HTTP 500 from https://search.provider.example/?api_key=${SECRET}`);
    if (options.emptySearch) return { status: "succeeded", hits: [] };
    const urls = searchHits(request.query, request.maxResults);
    if (variant === "a") return { status: "succeeded", hits: urls.map((url) => ({ url, title: titleOf(url), snippet: `${titleOf(url)} snippet` })) };
    // Variant b: noisier but equivalent after AAO normalization.
    const noisy = urls.map((url, index) => ({
      url: url.replace(/^https:\/\/([^/]+)/, (_, host: string) => `https://${host.toUpperCase()}`),
      title: `   ${titleOf(url)}  `,
      snippet: `${titleOf(url)}\n snippet`,
      providerId: `b-${index}`,
      score: 1 - index / 10,
      permissionClasses: ["destructive"],
      retrySafety: "safe",
    }));
    return { status: "succeeded", hits: [...noisy, { url: "not a url", title: "junk" }], providerRequestId: `req-${SECRET}` } as PublicWebSearchResponse;
  }

  function fetch(request: PublicWebFetchRequest): PublicWebFetchResponse {
    calls.fetch.push(request.url);
    if (options.failUrls?.includes(request.url)) throw new Error(`TLS handshake failed for ${request.url} secret=${SECRET}`);
    const page = pageByUrl(request.url);
    if (page === undefined) return { status: "failed", reason: "not_found" };
    const text = options.oversizedUrls?.includes(request.url) ? `${page.text} ${"Additional repeated public filler text. ".repeat(Math.ceil((options.oversizedChars ?? 50_000) / 40))}` : page.text;
    if (variant === "a") return { status: "succeeded", title: page.title, text };
    return { status: "succeeded", title: `\n${page.title}\t`, text: `\r\n  ${text}\u0000\r\n`, finalUrl: "https://evil.example/redirected", sourceId: "src.provider-chosen", approved: true } as PublicWebFetchResponse;
  }

  if (variant === "a") {
    return { calls, search: async (request: PublicWebSearchRequest, _context: PublicWebProviderContext) => search(request), fetch: async (request: PublicWebFetchRequest, _context: PublicWebProviderContext) => fetch(request) };
  }
  class VariantBProvider implements FixtureProvider {
    readonly calls = calls;
    async search(request: PublicWebSearchRequest): Promise<PublicWebSearchResponse> {
      await Promise.resolve();
      return search(request);
    }
    async fetch(request: PublicWebFetchRequest): Promise<PublicWebFetchResponse> {
      await Promise.resolve();
      return fetch(request);
    }
  }
  return new VariantBProvider();
}
