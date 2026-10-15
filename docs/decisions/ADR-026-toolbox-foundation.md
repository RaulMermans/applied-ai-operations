# ADR-026: Toolbox foundation

Status: accepted

## Context

By Sprint 20, AAO could define governed Tools (`defineTool`), register them explicitly (`createAAO({ tools })`), and execute them through one canonical path:

> Tool Registry → permission support gate → Authorization → input schema → handler → output schema

Every application still had to write its own basic capabilities, such as cleaning text, splitting it, or deduplicating records. Nothing existed to package such Tools once, describe them for discovery, version them, and verify them.

Sprint 21 had to make this true: *AAO has a reusable library of high-quality Tools that behave exactly like normal AAO Tools, execute only through the canonical Tool Runtime, carry useful discovery metadata, are versioned and evaluated, and remain independent of company-specific integrations and provider-specific adapters.*

## Inventory

| Concept | Where | Decision |
| --- | --- | --- |
| `ToolSpec`, `ToolSpecSchema` | `@aao/contracts` | **KEEP** as the only Tool description. The Toolbox adds no second spec. |
| `RegisteredTool`, Tool Registry, `executeTool`, Tool node | `@aao/tool-runtime` | **KEEP**. Toolbox Tools register and execute here, unchanged. |
| `defineTool`, `ToolDefinition`, `createAAO({ tools })` | `@aao/framework` | **KEEP** as the canonical public Tool definition. The Toolbox consumes it. |
| `retrySafety`, `idempotency`, recovery safety | contracts / Tool Runtime | **KEEP** as the one reliability vocabulary. There is no Toolbox reliability vocabulary. |
| `aao.tool-usage` and the other deterministic graders | `@aao/evaluation` | **KEEP**. Toolbox verification reuses them. There is no Toolbox evaluator. |
| `Skill`, `CapabilityPack` references | `@aao/contracts` | **UNCHANGED**. They stay separate concepts that the Toolbox neither uses nor imports. |

## Decision

### 1. `@aao/toolbox` is a curated Tool library, not a runtime

The new package `@aao/toolbox` (`packages/toolbox`) contains:

- curated Tool definitions;
- catalog and discovery metadata;
- quality evidence: tests and an Eval verification set.

It does not execute Tools. It has no executor, runtime, Authorization, retry engine, Approval engine, registry, or evaluator. A Toolbox Tool executes exactly like any other AAO Tool.

```text
Capability Packs                       (Sprint 26)
        ↓
Toolbox + Integration Fabric
        ↓
Tool Registry → Tool Runtime → Governance / Authorization
```

### 2. Dependency direction

The dependency direction is `@aao/toolbox → @aao/framework → AAO Core`. The Toolbox is a real consumer of the public Framework root: its Tools are `defineTool` definitions, and hosts register them with `createAAO`.

Its production dependencies are `@aao/framework`, `@aao/contracts` (identifier grammar and canonical JSON), and `zod`. Evaluation, Observability, and the Tool Runtime are test-only dependencies.

No Core package, app, or the Framework depends on or imports the Toolbox. Static tests in both packages enforce this.

### 3. ToolboxManifest V1 is strict, versioned, exact, and non-authoritative

A Toolbox is defined by `ToolboxManifest` V1 (`schemaVersion: 1`):

- an `id`;
- an exact `MAJOR.MINOR.PATCH` `version`;
- a `name` and a `description`;
- 1–64 `ToolboxEntry` items.

Each `ToolboxEntry` holds:

- an exact `toolRef` (`id` plus `MAJOR.MINOR.PATCH`; never `latest`, `^1`, or `>=1`);
- a slug `category`;
- 1–16 unique slug `tags`;
- 1–8 `whenToUse` and 1–8 `whenNotToUse` lines;
- 1–4 `examples` (a title, a JSON input object of at most 4,096 serialized characters, and optional notes);
- a `status` of `active` (the default) or `deprecated`;
- an optional `replacementRef`.

The schema is strict, so authority fields are rejected. An entry cannot carry `permissionClasses`, `inputSchema`, `outputSchema`, `retrySafety`, `idempotency`, a handler, or an Approval policy. Those stay authoritative in the Tool definition and the Tool Registry.

Deprecation informs readers only. A `replacementRef` must name another entry of the same Toolbox, and only a deprecated entry may carry one. Nothing ever rewrites a call from the old Tool to the new one. A deprecated Tool stays executable when a host registers it explicitly.

### 4. `defineToolbox` validates the manifest and the Tools as one package

`defineToolbox({ manifest, tools })` checks the following:

- **The manifest is strict and plain JSON.** A function, accessor, or class instance is refused before parsing.
- **Each Tool is re-validated.** It is re-validated through `defineTool` (the canonical Tool Registry checks) and snapshotted, so later mutation of the caller's spec or handler object cannot change it.
- **Each Tool is admissible.** It needs an exact version and a 40–2,000-character description. Its permission classes must be `read_only` or `write_draft`. This is a curation rule, not authority: the support gate and Authorization still decide every call.
- **Entries and Tools match one to one.** There is no orphan entry, no undocumented executable Tool, and no duplicate ref.

The result is frozen. Its Tool definitions are private to the Toolbox, held in a module `WeakMap` keyed by the Toolbox object. A look-alike object is refused by every catalog function. Two Toolboxes never share entries, Tools, or a search index.

### 5. Identity

Canonical Toolbox identity is `id + version`. `fingerprint` is SHA-256 over the canonical manifest (entries ordered by exact ref, tags sorted), so it covers the non-executable metadata and the exact Tool refs. It is catalog identity, not a software attestation, and it never hashes handler code.

A breaking Tool change needs a new Tool version: a change to input or output semantics, permission class, side-effect behavior, or Tool id. Removing a Tool or making any other breaking change to a Toolbox's composition needs a new Toolbox version.

### 6. The catalog is information; the Tool Registry is authority

The catalog API is pure and read-only:

- `listToolboxEntries` (filter by category, tag, or status);
- `getToolboxEntry` (exact ref only);
- `searchToolbox`;
- `describeToolbox`.

It returns frozen static metadata and never a handler, validator, or runtime state.

> **Permanent invariant.** The Toolbox Catalog describes discoverable reusable capabilities. The Tool Registry remains authoritative for executable Tool schemas, handlers, permissions, and versions.

Search is deterministic and lexical:

- **Tokens** are runs of Unicode letters and digits, lowercased in a locale-independent way.
- **Fields** are the Tool id, name, description, category, tags, whenToUse, whenNotToUse, and example titles and notes, each with an integer weight.
- **Scoring** gives an exact token match 2 × the field's weight, a prefix match of three or more characters 1 × the weight, and a whole-query match on the id a bonus of 50.
- **Ties** break by exact ref.
- **Bounds** are a query of at most 256 characters with at most 32 terms, and a limit of 1–20 (default 5).

There are no embeddings, model calls, Run history, popularity scores, or learned rankings.

Discovery grants zero permissions. `selectToolboxTools(toolbox, refs)` resolves exact refs to Tool definitions for explicit registration only. Importing the package registers nothing, and there is no global catalog. Tool exposure stays host- and Workflow-configured. No agent searches the catalog and gains Tools.

### 7. The AAO Core Toolbox (`aao.core@1.0.0`)

The Core Toolbox contains six Tools, all at version 1.0.0:

- `text.normalize`
- `text.chunk`
- `records.dedupe`
- `records.project`
- `records.sort`
- `records.count_by`

Each one is:

- `read_only`, registered `retrySafety: "safe"`, with idempotency `none` (the canonical default; pure computation needs no idempotency key);
- free of Approval;
- deterministic: no model, network, filesystem, environment, clock, randomness, or locale;
- bounded, with the limits documented in `CORE_TOOL_LIMITS`.

Handlers use only `input`. They never use the handler context's `toolExecutionId` or `signal`.

Output follows one Toolbox-only shape: `{ status: "success" | "empty" | "partial", data, meta }`.

Invalid input fails through the canonical channels. A schema violation is `TOOL_INPUT_SCHEMA_MISMATCH`. A cross-field or size constraint that JSON Schema cannot express is the handler's bounded failure code, reported as `TOOL_EXECUTION_FAILED` with `handlerFailureCode`. The codes are:

- `INVALID_CHUNK_OVERLAP`
- `INVALID_START_OFFSET`
- `INPUT_TOO_LARGE`
- `OUTPUT_TOO_LARGE`
- `UNSORTABLE_VALUE`
- `UNGROUPABLE_VALUE`
- `DUPLICATE_SORT_KEY`

A successful Toolbox result never carries `status: "error"`.

Nothing is silently truncated. An output that would exceed a bound is refused, or for `text.chunk` returned as `partial` with `meta.nextOffset`.

### 8. Verification reuses the Evaluation Runtime

Twenty RUNTIME cases run on real Framework Runs and are judged by seven existing graders:

- `aao.tool-usage`
- `aao.authorization-compliance`
- `aao.run-outcome`
- `aao.trajectory`
- `aao.state-assertion`
- `aao.trace-contract`
- `aao.retry-behavior`

The cases cover invocation, required, forbidden (with a negative control), Authorization denial, invalid arguments, bounds, partial output, trajectory, retry, trace privacy, and catalog non-authority.

A generated catalog (`docs/generated/toolbox-core.json`, `docs/toolbox/core-tools.md`) is rendered from `describeToolbox(coreToolbox)`. A drift test fails on any difference.

### 9. Boundaries with neighbouring concepts

- **Toolbox ≠ Integration Fabric.** Provider and system access (MCP, Slack, Google Workspace, CRMs, GitHub, web search, REST, databases) is not a Toolbox Tool.
- **Toolbox ≠ Capability Pack.** Business operations composed from Workflows, Tools, Agents, policies, and Evals, such as company research, are Sprint 22+. A Capability Pack may import Toolbox Tools. The Toolbox never imports a Capability Pack.
- **Toolbox ≠ Skill.** A Tool executes something. Procedures, writing styles, rubrics, and prompt templates are not Tool metadata.
- **Toolbox ≠ Memory.** There is no Tool preference memory, success history, embedding, learned routing, or procedure promotion.
- **Toolbox ≠ code execution.** `run_python`, shell, `eval`, and similar need a separate sandbox architecture.

The quality loop is governed and offline:

> Trace → Eval → repeated Tool failure → human change → new Tool version → regression tests → new Toolbox version

Nothing is promoted automatically.

## Consequences

- Applications reuse governed Tools without bypassing any control. The Runtime, Tool Runtime, Authorization, Approval, retry, Trace, Audit, and durability code is unchanged.
- The Framework's static boundary test now names `@aao/toolbox` as the only Framework consumer inside `packages/`.
- **A Core fix landed separately.** `canonicalJsonStringify` dropped own `"__proto__"` keys. That was a fingerprint collision, fixed in its own commit.
- **Known Core limitation, not changed here.** The Tool Runtime parses requests with Zod's `JsonValueSchema`, which strips own `"__proto__"` keys before any handler runs. This never pollutes anything, but it does drop data silently. Toolbox handlers stay safe either way: they read fields as own properties and copy with `Object.fromEntries`.
- **Explicit exclusions.** There is no CLI, remote registry, installer, marketplace, semantic retrieval, automatic Tool exposure, company configuration, or Capability Pack.
