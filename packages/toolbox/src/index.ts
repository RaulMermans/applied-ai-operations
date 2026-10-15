// @aao/toolbox — the AAO Toolbox (Sprint 21, ADR-026,
// docs/architecture/toolbox.md).
//
// A curated, versioned, provider-neutral library of reusable Tools plus
// discovery metadata. It is not a Tool Runtime: Toolbox Tools are normal
// AAO Tool definitions (`defineTool` from @aao/framework) that a host
// selects explicitly and registers with `createAAO`, where the canonical
// Tool Registry, support gate, Authorization, schema validation, Trace, and
// reliability govern every call exactly as for any other Tool. Toolbox
// metadata is never authority, discovery grants no permission, and
// importing this package registers nothing.
//
// Everything exported here is intentional consumer API: an explicit list,
// never `export *`, pinned by the public API snapshot test.

export { ToolboxError, type ToolboxErrorCode } from "./errors.js";
export { defineToolbox, type DefineToolboxInput, type Toolbox, type ToolboxCatalogEntry, type ToolboxEntry, type ToolboxEntryInput, type ToolboxExample, type ToolboxManifest, type ToolboxManifestInput, type ToolboxRef, type ToolboxToolRef } from "./contract.js";
export {
  describeToolbox,
  getToolboxEntry,
  listToolboxEntries,
  searchToolbox,
  selectToolboxTools,
  type ToolboxDescription,
  type ToolboxEntryFilter,
  type ToolboxSearchField,
  type ToolboxSearchQuery,
  type ToolboxSearchResult,
  type ToolboxToolDescription,
} from "./catalog.js";
export { CORE_TOOL_LIMITS } from "./core/limits.js";
export { coreToolbox } from "./core/index.js";
