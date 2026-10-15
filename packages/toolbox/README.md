# @aao/toolbox

The AAO Toolbox is a curated, versioned, provider-neutral library of reusable Tools, plus the discovery metadata that helps people and agents find the right one.

Toolbox Tools are normal AAO Tool definitions. They plug into the same governed Tool Runtime as your application's own Tools. The Toolbox never executes, authorizes, retries, or registers anything itself.

```text
Toolbox (manifest · discovery metadata · normal Tool definitions)
   → explicit selection → createAAO({ tools }) → Tool Registry → Tool Runtime
   → support gate → Authorization → input validation → handler → output validation
```

## Quickstart

```ts
import { createAAO } from "@aao/framework";
import { coreToolbox, selectToolboxTools } from "@aao/toolbox";

// Importing @aao/toolbox registers nothing. Pick exact Tool refs.
const tools = selectToolboxTools(coreToolbox, [
  { id: "text.chunk", version: "1.0.0" },
  { id: "records.dedupe", version: "1.0.0" },
]);

const app = createAAO({ governance, principalForRun, tools });
```

The selected Tools are now registered like any other Tool. A Workflow `tool` node calls them by exact ref, and the principal still needs `read_only`.

## The AAO Core Toolbox (`aao.core@1.0.0`)

| Tool | What it does |
| --- | --- |
| `text.normalize` | Converts line endings to LF and trims outer whitespace. On request it also trims trailing whitespace, caps blank-line runs, or applies one named Unicode normalization form. |
| `text.chunk` | Splits text into bounded chunks by UTF-16 offset, with optional overlap. Chunks never split a surrogate pair. If it stops early, the result is `partial` with a continuation offset. |
| `records.dedupe` | Removes exact duplicates by selected top-level keys. A missing key and `null` differ, and values are never coerced. It keeps the first record by default. |
| `records.project` | Keeps the listed top-level fields. Missing fields are omitted, never invented as `null`. |
| `records.sort` | Stable sort by up to 3 scalar fields. Order is booleans < numbers < strings (by code unit, with no locale rules), then `null`, then missing. |
| `records.count_by` | Counts records by one scalar field. Missing, `null`, and each typed value form separate groups. |

Every Core Tool is `read_only` and registered `retrySafety: "safe"`. None needs Approval. All are pure computation: no model, network, filesystem, environment, clock, or randomness.

The full generated reference covers inputs, limits, outputs, and examples: [docs/toolbox/core-tools.md](../../docs/toolbox/core-tools.md). The same catalog as JSON is [docs/generated/toolbox-core.json](../../docs/generated/toolbox-core.json).

## Discovery

The catalog API is read-only and returns no handlers:

- `listToolboxEntries(toolbox, filter?)`
- `getToolboxEntry(toolbox, ref)`
- `searchToolbox(toolbox, { query, limit? })`
- `describeToolbox(toolbox)`

Search is deterministic and lexical. It uses no embeddings, no model, and no Run history.

A search result grants no permission and registers nothing. Only the Tools a host passes to `createAAO` are executable.

## Your own Toolbox

```ts
import { defineTool } from "@aao/framework";
import { defineToolbox } from "@aao/toolbox";

const myToolbox = defineToolbox({
  manifest: {
    id: "acme.text",
    version: "1.0.0",
    name: "Acme text tools",
    description: "…",
    entries: [{ toolRef: { id: "acme.slugify", version: "1.0.0" }, category: "text", tags: ["slug"], whenToUse: ["…"], whenNotToUse: ["…"], examples: [{ title: "…", input: { text: "Hello World" } }] }],
  },
  tools: [defineTool({ spec: slugifySpec, handler: slugify, retrySafety: "safe" })],
});
```

`defineToolbox` validates the manifest and the Tools as one package:

- The manifest is strict. Fields such as `permissionClasses`, `inputSchema`, `retrySafety`, or `handler` are rejected in an entry.
- Refs are exact `MAJOR.MINOR.PATCH`. There is no `latest`.
- Entries and Tools must match one to one.
- Tools need a substantive description, and only `read_only` / `write_draft` Tools are admitted.

The result is frozen.

A Tool belongs in a Toolbox only if it is reusable across deployments, provider-independent, narrowly governed, deterministic or well-bounded, documented for correct use, and backed by tests and evals.

See [ADR-026](../../docs/decisions/ADR-026-toolbox-foundation.md) and [the Toolbox architecture](../../docs/architecture/toolbox.md).
