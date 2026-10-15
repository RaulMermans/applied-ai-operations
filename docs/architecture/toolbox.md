# Toolbox

`@aao/toolbox` (`packages/toolbox`, Sprint 21, [ADR-026](../decisions/ADR-026-toolbox-foundation.md)) is AAO's curated library of reusable, provider-neutral Tools. Common capabilities are packaged once, discovered consistently, selected explicitly, and reused across applications. They still pass through the same governed Tool Runtime as every other AAO Tool.

```text
Toolbox
   │
   ├── manifest                (ToolboxManifest V1: id@version, exact Tool refs)
   ├── discovery metadata      (category, tags, whenToUse, whenNotToUse, examples, status)
   └── normal Tool definitions (defineTool: ToolSpec + handler + retrySafety)
            │  selectToolboxTools(toolbox, exact refs)   ← explicit, by the host
            ▼
       createAAO({ tools })
            │
            ▼
       Tool Registry           (authoritative: schemas, handler, permission classes, version)
            │
            ▼
       Tool Runtime            support gate → Authorization → input schema → handler → output schema
            │
            ▼
       Governance / Authorization · Reliability · Trace · Audit · Durability (unchanged)
```

## What it is not

- **Toolbox ≠ Tool Runtime.** It never executes, authorizes, retries, approves, or registers anything. There is no special execution path.
- **Toolbox ≠ Adapter.** Adapters map external substrates into AAO contracts ([ADR-025](../decisions/ADR-025-adapter-and-portability-contract.md)). Core Toolbox Tools are native, pure handlers.
- **Toolbox ≠ Integration Fabric.** Provider and system access (MCP servers, Slack, Google Workspace, CRMs, GitHub, web search, REST, databases) is a separate layer.
- **Toolbox ≠ Capability Pack.** Business operations (company research, document intelligence, request handling) compose Workflows, Tools, Agents, policies, and Evals. A Capability Pack may import Toolbox Tools, never the reverse.
- **Toolbox ≠ Skill.** A Tool executes something. A Skill teaches an agent how to do something. Procedures, rubrics, styles, and prompt templates are not Tool metadata.
- **Toolbox ≠ Memory.** There is no preference memory, success history, embeddings, learned routing, or self-improving selection. The Tool Registry stays authoritative.

## Ownership

| Concern | Owner |
| --- | --- |
| Reusable Tool package and catalog | `@aao/toolbox` |
| Callable Tool definitions (schemas, handler, permission classes, version) | Tool Registry (`@aao/tool-runtime`), via `defineTool` / `createAAO` |
| Execution, support gate, input and output validation | Tool Runtime |
| Who may execute | Governance + Authorization |
| Retries, timeouts | Runtime Reliability Controller, from the Tool's registered `retrySafety` |
| Evidence | Trace / Audit (`@aao/observability`), judged by `@aao/evaluation` |
| External substrate compatibility | Adapters (`@aao/adapters`) |

The dependency direction is `@aao/toolbox → @aao/framework → Core`. Core and the Framework never import the Toolbox.

## Contract

`ToolboxManifest` V1 is strict, JSON-safe, and versioned. Its identity is `id` + exact `MAJOR.MINOR.PATCH` `version`. Each entry pins one Tool by an exact ref; there is no `latest` and no range. Entries carry discovery metadata only.

An entry with `permissionClasses`, `inputSchema`, `outputSchema`, `retrySafety`, `idempotency`, a handler, an Approval policy, or any other unknown field is rejected.

`defineToolbox({ manifest, tools })` validates the manifest and the Tools as one package:

- every Tool is re-validated through `defineTool` and snapshotted;
- Toolbox Tools need an exact version, a substantive description, and `read_only` / `write_draft` permission classes;
- entries and Tools must match one to one.

The Toolbox is frozen. Its Tool definitions are private and handed out only by `selectToolboxTools`. `fingerprint` is SHA-256 over the canonical manifest: catalog identity, never a code attestation.

Deprecation (`status: "deprecated"`, optional `replacementRef` to another entry) only informs readers. A deprecated Tool stays executable when explicitly registered, and nothing replaces it automatically.

**Inclusion standard.** A Tool belongs in an AAO Toolbox only if it is reusable across multiple deployments, provider-independent, narrowly governed, deterministic or well-bounded, documented for correct use, and backed by tests and evals.

**Exclusion standard.** Reject a proposed Toolbox Tool that is primarily any of these:

- company-specific, provider-specific, or workflow-specific;
- credential-bound;
- an unsafe side effect;
- arbitrary code execution;
- a thin low-level API wrapper.

Not every AAO Tool qualifies for a Toolbox. That is by design.

## Catalog and discovery

| Function | Returns |
| --- | --- |
| `listToolboxEntries(toolbox, { category?, tag?, status? })` | Frozen catalog entries, ordered by exact ref |
| `getToolboxEntry(toolbox, ref)` | One entry for an exact ref, or `undefined` |
| `searchToolbox(toolbox, { query, limit?, category?, tag?, status? })` | `{ toolRef, category, status, score, matchedFields }[]` |
| `describeToolbox(toolbox)` | A static JSON description (`authority: "none"`): the source for generated docs |
| `selectToolboxTools(toolbox, refs)` | Frozen Tool definitions for explicit registration |

Search is deterministic lexical retrieval over the Tool id, name, description, category, tags, whenToUse, whenNotToUse, and examples. Field weights are integers, and ties break by exact ref.

Its bounds are a query of at most 256 characters with at most 32 terms, and a limit of 1–20 (default 5). An empty query is rejected.

**Discovery grants no permission.** A search result registers nothing and authorizes nothing. A Tool the host did not select fails preflight as unregistered, even when the catalog lists it.

The future direction may become:

> task → semantic catalog search → candidate refs → permission filter → selected schemas

Sprint 21 deliberately stops at authoritative metadata and lexical retrieval.

## The AAO Core Toolbox

`coreToolbox` is `aao.core@1.0.0`. Every Tool in it is:

- `read_only`, `retrySafety: "safe"`, idempotency `none`;
- free of Approval;
- pure computation over supplied input.

The generated reference is [docs/toolbox/core-tools.md](../toolbox/core-tools.md) (data: [docs/generated/toolbox-core.json](../generated/toolbox-core.json)).

| Tool | Semantics |
| --- | --- |
| `text.normalize` | Fixed order: an optional named Unicode form, then CRLF/CR → LF (always), then optional trailing space/tab trimming per line, then an optional cap on consecutive blank lines, then outer `trim` (default on). `meta.changesApplied` lists only the steps that changed the text. |
| `text.chunk` | Chunks are UTF-16 code-unit offsets, and `chunk.text === text.slice(start, end)`. `maxChars` is 2–20,000 and `overlapChars` must be below it. A boundary never splits a surrogate pair. `maxChunks` (1–1,000, default 100) or the 1,048,576-unit output bound produces `status: "partial"` with `meta.nextOffset` (pass it as `startOffset`). |
| `records.dedupe` | A tuple of selected top-level keys, each either missing or its canonical JSON value. There is no coercion, and a missing key differs from `null`. `keep: "first"` (default) or `"last"`, and kept records stay in original relative order. Matching is exact, never fuzzy. |
| `records.project` | The listed top-level fields in listed order, with record order preserved. A missing field is omitted, never invented as `null`, and counted in `meta.missing`. There are no paths or expressions. |
| `records.sort` | Up to 3 keys, `asc` (default) or `desc`. Order: booleans < numbers < strings (code units, no locale), then `null`, then missing; `desc` flips only present values. The sort is stable with an explicit index tie-break. An object or array value is refused (`UNSORTABLE_VALUE`). |
| `records.count_by` | Groups are `{ kind: missing \| null \| boolean \| number \| string, value?, count }`, with no sentinel strings. Ordering is count descending, then the canonical scalar order. A non-scalar value is refused (`UNGROUPABLE_VALUE`). |

### Resource bounds (`CORE_TOOL_LIMITS`)

| Bound | Value | Enforcement |
| --- | --- | --- |
| Text input | 262,144 characters (JSON Schema `maxLength`, code points) | input schema |
| `text.normalize` output | 524,288 UTF-16 units | handler: `OUTPUT_TOO_LARGE` |
| Blank-line cap | 0–10 | input schema |
| Chunk size / overlap | 2–20,000 / below `maxChars` | input schema / handler `INVALID_CHUNK_OVERLAP` |
| Chunks per call | 1–1,000 (default 100) | input schema; beyond → `partial` |
| Chunk text per call | 1,048,576 UTF-16 units | handler; beyond → `partial` |
| Records per call | 1,000 | input schema |
| Fields per record | 256 | input schema |
| Field name length | 1–128 | input schema |
| Selected fields | 1–64, unique | input schema |
| Sort keys | 1–3, distinct fields | input schema / handler `DUPLICATE_SORT_KEY` |
| Serialized records | 1,048,576 characters | handler: `INPUT_TOO_LARGE` |

Inputs and outputs are canonical JSON. A non-finite number cannot enter a Run or a Tool request at all. Record Tools read fields as own properties only and copy with `Object.fromEntries`, so `__proto__`, `constructor`, and `prototype` are ordinary field names and never reach a prototype.

The Tool Runtime's request parsing (Zod `JsonValueSchema`) strips own `"__proto__"` keys before any handler runs. That is a Core behavior, recorded in ADR-026.

### Output shape

Every Core Tool returns `{ status, data, meta }`:

- `status` is `success`, `empty`, or `partial` (chunking only).
- `data` holds the result.
- `meta` holds bounded facts such as counts, lengths, and continuation.

Failures never appear inside a successful output. They use the Tool Runtime's own channel:

- `TOOL_INPUT_SCHEMA_MISMATCH` for schema violations;
- `TOOL_EXECUTION_FAILED` with a bounded `handlerFailureCode` for constraints JSON Schema cannot express;
- `TOOL_OUTPUT_SCHEMA_MISMATCH` if a handler ever broke its contract.

## Usage

```ts
import { createAAO } from "@aao/framework";
import { coreToolbox, selectToolboxTools } from "@aao/toolbox";

const tools = selectToolboxTools(coreToolbox, [
  { id: "text.chunk", version: "1.0.0" },
  { id: "records.dedupe", version: "1.0.0" },
]);
const app = createAAO({ governance, principalForRun, tools });
```

Workflow `tool` nodes then reference those exact refs. Chaining one Tool's output into the next Tool's input is trusted host glue, typically a `deterministic` node.

## Verification

| Evidence | Where |
| --- | --- |
| Contract matrix: strict manifest, exact refs, one-to-one entries, admission, immutability, isolation, identity | `packages/toolbox/test/contract.test.ts` |
| Catalog: list, get, search (fields, ranking, ties, bounds, determinism), selection, describe | `test/catalog.test.ts` |
| Tool semantics, bounds, Unicode, offsets, prototype-pollution regression, determinism | `test/text-tools.test.ts`, `test/record-tools.test.ts` |
| Framework → Tool Runtime path for every Tool and example | `test/runtime.test.ts` |
| Authorization denial (zero handler calls), output schema, metadata non-authority, permission non-escalation, Runtime retry, Audit, Trace privacy | `test/runtime.test.ts` |
| Twenty RUNTIME Eval cases judged by seven existing graders | `test/evals.test.ts` |
| Generated catalog drift | `test/generated-catalog.test.ts` |
| API snapshot, dependency and purity scans (static) | `test/public-api.test.ts` |
| Runtime purity: no socket, `fetch`, filesystem, environment, clock, or randomness while every example runs | `test/purity.test.ts` |
| Packaging | `test/packaging.test.ts` |
| Public consumer (imports only `@aao/framework` + `@aao/toolbox`) | `test/consumer.e2e.test.ts` |
| Compiled smoke: dist-only consumer, Trace, Eval, non-authority, drift, pack (`SPRINT_21_TOOLBOX_FOUNDATION_SMOKE_OK`) | `smoke/sprint21.mjs` |

## Quality loop (future, governed, offline)

```text
Trace → Eval → repeated Tool failure → human/developer change → new Tool version → regression tests → new Toolbox version
```

Nothing in the loop is automated. Runtime traces never change the catalog, and no popularity or success score affects ranking.
