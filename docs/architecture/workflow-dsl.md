# Workflow DSL

`@aao/workflow-dsl` (`packages/workflow-dsl`) turns an authored Workflow source document into a framework-neutral, deterministic compiled plan a future runtime can trust. See [ADR-008](../decisions/ADR-008-workflow-dsl-and-compiler.md) for the accepted decision this document elaborates, and [domain contracts](domain-contracts.md) for the canonical `Workflow`/`Node`/`Edge` shapes this package consumes rather than redefines.

```text
@aao/workflow-dsl
        ↓
@aao/contracts
        ↓
        ✕
external frameworks / vendors / providers
```

## Authoring

V1 authoring supports **YAML** and **JSON** only — no custom workflow programming language. The authoring shape mirrors the canonical `Workflow` contract as closely as possible: `schemaVersion`, `id`, `version`, `name`, `description?`, `entryNodeId`, `nodes`, `edges`, `requiredCapabilities?`. Future DSL convenience syntax may be layered on later without changing the canonical `Workflow` contract underneath it.

## Pipeline

```text
Source (YAML or JSON)
        ↓  parseWorkflowSource
Raw value
        ↓  WorkflowSchema (from @aao/contracts)
Schema-valid Workflow
        ↓  validateWorkflowSemantics
Semantically valid Workflow
        ↓  compileWorkflow
CompiledWorkflowPlan
```

`compileWorkflowSource(source, format)` runs the whole pipeline in one call. Every stage returns a discriminated result — `{ ok: true, ... } | { ok: false, diagnostics }` — rather than throwing for expected input problems; only unexpected internal errors throw. One source document is one workflow — multi-document YAML is not supported in V1.

## Public API

```ts
parseWorkflowSource(source: string, format: "yaml" | "json"): WorkflowParseResult;
validateWorkflowSemantics(workflow: Workflow): WorkflowDiagnostic[];
compileWorkflow(workflow: Workflow): WorkflowCompileResult;
compileWorkflowSource(source: string, format: "yaml" | "json"): WorkflowCompileResult;
```

None of these functions depend on the filesystem, a CLI, Fastify, the Worker, a database, or Git — they operate purely on provided content. A future caller (CLI, Control Plane route, test) decides how it obtained the source text.

## Structural semantics

Semantic validation runs in a fixed, deterministic order and collects every independent violation in one pass rather than stopping at the first:

1. **Node identity** — node ids must be unique (`DUPLICATE_NODE_ID`).
2. **Entry node** — `entryNodeId` must reference an existing node (`ENTRY_NODE_NOT_FOUND`).
3. **Edge references** — every edge's `sourceNodeId`/`targetNodeId` must reference an existing node (`EDGE_SOURCE_NOT_FOUND`, `EDGE_TARGET_NOT_FOUND`). An edge with a missing endpoint is excluded from every later structural check so it cannot cascade into unrelated diagnostics.
4. **Duplicate edges** — an edge that exactly duplicates an earlier edge's `sourceNodeId` + `targetNodeId` + `condition` is rejected (`DUPLICATE_EDGE`). `condition` is compared via a canonical, key-sorted JSON form (`src/canonical-json.ts`), so `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` are treated as the same condition for this comparison. Condition semantics are never evaluated — structural equality is used only for duplicate-edge detection. Different conditions routing to the same target remain valid.
5. **Reachability** — every node must be reachable from `entryNodeId` via valid edges (`UNREACHABLE_NODE`). This check only runs once an entry node is known to exist; "reachable from an undefined starting point" is not a meaningful check.
6. **Terminal semantics** — a `final_output` node must have no outgoing edges (`FINAL_OUTPUT_HAS_OUTGOING_EDGE`); every other node must have at least one outgoing edge, so termination is always explicit (`NON_FINAL_TERMINAL_NODE`).
7. **Routing** — a node with a single *unconditional* outgoing edge is a valid simple route. A node whose only outgoing edge is conditional has no fallback and is rejected (`CONDITIONAL_ROUTE_WITHOUT_DEFAULT`): a condition can fail to match at runtime, so at least one unconditional default is required whenever any outgoing edge is conditional. A node with multiple outgoing edges may have at most one unconditional edge, which acts as the default/fallback route: more than one unconditional edge is ambiguous (`AMBIGUOUS_ROUTING`); multiple conditional edges with none unconditional have no fallback (also `CONDITIONAL_ROUTE_WITHOUT_DEFAULT`). Condition *contents* are never evaluated — only their presence/absence matters structurally.
8. **Cycles** — rejected as a Workflow Compiler V1 limitation (`CYCLE_NOT_SUPPORTED`), detected via an iterative (non-recursive) depth-first traversal so a large graph cannot overflow the call stack. This is not a permanent prohibition — see ADR-008.

## Diagnostics

Every diagnostic is a small, JSON-safe object:

```ts
interface WorkflowDiagnostic {
  code: WorkflowDiagnosticCode;
  message: string;
  path?: string;      // dot-joined pointer into the source, e.g. "nodes.0.kind"
  nodeId?: string;     // populated when the diagnostic is anchored to a node
  edgeIndex?: number;  // populated when the diagnostic is anchored to an edge
}
```

Stable codes: `PARSE_ERROR`, `SCHEMA_VALIDATION_ERROR`, `DUPLICATE_NODE_ID`, `ENTRY_NODE_NOT_FOUND`, `EDGE_SOURCE_NOT_FOUND`, `EDGE_TARGET_NOT_FOUND`, `DUPLICATE_EDGE`, `UNREACHABLE_NODE`, `CYCLE_NOT_SUPPORTED`, `FINAL_OUTPUT_HAS_OUTGOING_EDGE`, `NON_FINAL_TERMINAL_NODE`, `AMBIGUOUS_ROUTING`, `CONDITIONAL_ROUTE_WITHOUT_DEFAULT` (see `WORKFLOW_DIAGNOSTIC_CODES` in `src/diagnostics.ts`). Raw Zod issues and raw YAML/JSON parser errors are never exposed directly — they are normalized into this shape, with node/edge context attached whenever it is derivable from the issue path. No diagnostic message includes a parser stack trace, a file path outside the source document, or environment data.

## The compiled plan

```ts
interface CompiledWorkflowPlan {
  schemaVersion: 1;
  workflow: Workflow;
  entryNodeId: string;
  nodesById: Record<string, NodeDefinition>;
  outgoingEdgesByNode: Record<string, EdgeDefinition[]>;
  incomingEdgesByNode: Record<string, EdgeDefinition[]>;
  terminalNodeIds: string[];
}
```

The plan is built from a deep JSON clone of the input `Workflow`, so `compileWorkflow` never mutates its caller's object. It contains no `Map`, `Set`, class instance, or function — it is plain, JSON-safe data that survives `JSON.stringify` → `JSON.parse` without semantic loss, and compiling the same workflow repeatedly produces equivalent output (no timestamps, random ids, or environment-dependent values). Equivalent YAML and JSON source documents compile into equivalent plans.

`CompiledWorkflowPlanSchema` (`src/compiled-plan-schema.ts`) is a runtime-validatable Zod schema for this same shape, with `CompiledWorkflowPlan` inferred from it. `compileWorkflow` itself never needs it — it controls every field it writes — but a consumer that receives a plan it did not produce (the Runtime, in `@aao/runtime`) can validate it defensively rather than trusting the TypeScript type alone. This is the reason this package depends on `zod` directly, not only transitively through `@aao/contracts`.

## Deferred semantics

Explicitly out of scope for this sprint — do not assume any of the following exists yet:

- Condition **evaluation** (conditions remain opaque, inert JSON; only their structural presence is validated)
- Node-specific **config validation** (`toolRef`, `agentRef`, `modelPolicyRef`, `approvalPolicy`, or any other node `config` content) — belongs to Runtime preflight and each registered executor
- **Tool / Capability / Agent / Skill existence** checks against a real registry — none exists yet
- **State reducers** or any state/checkpoint persistence
- **Execution** of any kind — a compiled plan is not an executed plan
- **Retries**, **replanning**, or approval **waitpoint** execution
- **Runtime evals**

## Examples

- [`examples/workflows/minimal.yaml`](../../packages/workflow-dsl/examples/workflows/minimal.yaml) — the smallest valid shape: one deterministic node routing directly to an explicit `final_output`.
- [`examples/workflows/conditional-routing.yaml`](../../packages/workflow-dsl/examples/workflows/conditional-routing.yaml) — an entry node fanning out into two conditional branches plus one explicit default branch, converging on a shared `final_output`.
- [`examples/workflows/governed-operational-request.yaml`](../../packages/workflow-dsl/examples/workflows/governed-operational-request.yaml) — the structural shape of intake → reasoning → a proposed tool action → required approval → explicit final output, using provider-neutral capability references. None of these examples execute; they are structural proof only.
