// @aao/integration-public-web — the first Integration Fabric capability
// (Sprint 22, ADR-027, docs/architecture/integration-fabric.md).
//
// Public-web access exposed as two normal, governed AAO Tools —
// `public_web.search` and `public_web.fetch_pages` — around a narrow
// provider port that trusted host code supplies. It is not a Tool Runtime,
// not an adapter kind, and not part of the Toolbox: the Tools are defined
// with `defineTool` from @aao/framework and execute only through the
// canonical Tool Registry, support gate, Authorization, schema validation,
// Trace, and Runtime reliability. This package names no provider SDK and
// performs no network access itself; importing it registers nothing.
//
// Everything exported here is intentional consumer API: an explicit list,
// never `export *`, pinned by the public API snapshot test.

export { PUBLIC_WEB_LIMITS } from "./limits.js";
export type { PublicWebFetchRequest, PublicWebFetchResponse, PublicWebProvider, PublicWebProviderContext, PublicWebProviderFailureReason, PublicWebProviderHit, PublicWebSearchRequest, PublicWebSearchResponse } from "./provider.js";
export { canonicalizePublicWebUrl, publicWebSourceId } from "./url.js";
export {
  PUBLIC_WEB_FETCH_TOOL_REF,
  PUBLIC_WEB_SEARCH_TOOL_REF,
  createPublicWebTools,
  type PublicWebFailureCode,
  type PublicWebFetchInput,
  type PublicWebFetchOutput,
  type PublicWebPage,
  type PublicWebSearchHit,
  type PublicWebSearchInput,
  type PublicWebSearchOutput,
  type PublicWebTools,
  type PublicWebToolsOptions,
} from "./tools.js";
