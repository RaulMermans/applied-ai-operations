# @aao/integration-public-web

The first AAO **Integration Fabric** capability: public-web search and page fetch, exposed as two normal, governed AAO Tools around a provider that your host code supplies.

```text
createPublicWebTools({ provider })  →  public_web.search, public_web.fetch_pages  (normal ToolDefinitions)
   → createAAO({ tools }) → Tool Registry → Tool Runtime
   → support gate → Authorization (read_only) → input schema → handler → provider → normalization → output schema
```

This package is not a Tool Runtime, not an adapter kind, and not part of the Toolbox. It performs no network access itself and names no search vendor. Importing it registers nothing.

## Quickstart

```ts
import { createAAO } from "@aao/framework";
import { createPublicWebTools, type PublicWebProvider } from "@aao/integration-public-web";

// Your host code owns the provider: a search API client, a crawler, or a fixture.
const provider: PublicWebProvider = {
  async search({ query, maxResults }, { signal }) {
    return { status: "succeeded", hits: [/* { url, title, snippet } */] };
  },
  async fetch({ url, maxChars }, { signal }) {
    return { status: "succeeded", title: "…", text: "…plain text…" };
  },
};

const web = createPublicWebTools({ provider });
const app = createAAO({ governance, principalForRun, tools: [web.search, web.fetchPages] });
```

A Workflow `tool` node references `{ id: "public_web.search", version: "1.0.0" }` or `{ id: "public_web.fetch_pages", version: "1.0.0" }`. The principal needs `read_only`. Without it the Tool Runtime denies the call and the provider is never called.

## The Tools

| Tool | Input | Output |
| --- | --- | --- |
| `public_web.search@1.0.0` | `queries` (1–8, ≤ 256 chars each, unique after whitespace/case normalization), `resultsPerQuery` (1–5, default 3), `allowedDomains` (≤ 16) | `status` (`success`, `partial`, `empty`), `data.hits[]` (`queryIndex`, `rank`, `sourceId`, canonical `url`, `title`, optional `snippet`), `data.failures[]`, `meta` counts |
| `public_web.fetch_pages@1.0.0` | `urls` (0–20 unique http(s) URLs), `maxCharsPerPage` (≤ 20,000), `maxTotalChars` (≤ 100,000) | `status`, `data.pages[]` (`fetchIndex`, `sourceId`, canonical `url`, `title`, `text`, `truncated`), `data.failures[]`, `meta` counts |

Both are `read_only`, declared retry-safe (a public read has no side effect), and validated by the Tool Runtime's strict input and output schemas.

## Semantics

- **Provider budget.** One provider call per query and per URL, sequentially. That is at most 8 search calls and 20 fetch calls per Tool execution. A page beyond `maxTotalChars` is never requested (`TEXT_BUDGET_EXHAUSTED`).
- **Source identity is AAO's.** `sourceId` is `src.` plus 16 hex characters of SHA-256 over the canonical URL. It never depends on rank, position, or a provider id. A fetch page's URL is the one AAO requested; a provider cannot redirect it.
- **URLs.** Only absolute `http:`/`https:` URLs without embedded credentials. They are canonicalized with the WHATWG URL serializer, and the fragment is dropped.
- **Provider data is untrusted.** Only `url`, `title`, `snippet`, and `text` are read. Any other field (ids, permissions, retry hints, approval claims, instructions) is ignored. Titles and snippets are whitespace-collapsed and bounded. Page text has control characters removed and is bounded without splitting a surrogate pair.
- **Failures.** A thrown or rejected provider call is `PROVIDER_ERROR`, and the thrown value is never read. A malformed response is `MALFORMED_PROVIDER_RESPONSE`. Provider reasons map to `NOT_FOUND`, `BLOCKED`, `UNAVAILABLE`, and `UNSUPPORTED_CONTENT`. Any failure makes the result `partial`, and successful hits and pages are kept.
- **Outage.** When every provider call fails without an answer (`PROVIDER_ERROR`, `MALFORMED_PROVIDER_RESPONSE`, `UNAVAILABLE`, `CANCELLED`), the Tool fails with the retryable handler code `PUBLIC_WEB_PROVIDER_UNAVAILABLE`. Whether to retry is the Runtime's reliability policy, never this package's.
- **Cancellation.** The Tool Runtime's `signal` is passed to the provider unchanged. Once it is aborted, no further provider call is made.

## Provider responsibilities

A concrete provider performs the network access, so it owns safe network resolution: SSRF protection, private address ranges, redirects, robots rules, rate limits, and its own credentials. Keep credentials in the provider, never in Workflow definitions or Tool input.

See [ADR-027](../../docs/decisions/ADR-027-company-research-proof.md) and [Integration Fabric](../../docs/architecture/integration-fabric.md).
