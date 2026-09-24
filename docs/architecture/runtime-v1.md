# Runtime V1

`@aao/runtime` (`packages/runtime`) is the first production execution engine for a `CompiledWorkflowPlan`. See [ADR-009](../decisions/ADR-009-node-registry-and-runtime-v1.md) for the accepted decision this document elaborates, and [workflow DSL](workflow-dsl.md) for the compiler stage that produces the plan this package consumes.

```text
@aao/runtime
        ↓
@aao/contracts
        ↓
@aao/workflow-dsl
        ↓
        ✕
external frameworks / vendors / providers
```

## Pipeline

```text
CompiledWorkflowPlan
        ↓  validateRuntimeInput   (request shape, RunState, plan schema, runId identity)
        ↓  runPreflight           (plan integrity, conditional routing, registered executors)
Entry node
        ↓  Node Registry lookup
        ↓  Node executor
Validated result
        ↓  applyStatePatch
State patch
        ↓  unconditional route
Next node
        ↓  ...
final_output
        ↓
COMPLETED
```

`executeWorkflow` (`src/engine.ts`) runs this whole pipeline. Expected failures (bad input, a preflight rejection, an executor throwing, a malformed result, exceeding the step ceiling) are returned as a `{ ok: false, failure }` value, never thrown — only an unexpected internal invariant violation may still throw.

## Workflow valid ≠ Runtime V1 supports every feature

A `CompiledWorkflowPlan` that compiled successfully is not necessarily a plan Runtime V1 can execute. For example, a workflow containing a `model` node compiles successfully (`@aao/workflow-dsl` has no opinion on node kinds beyond the canonical enum), but Runtime V1 returns `NODE_EXECUTOR_NOT_FOUND` unless a `model` executor has been explicitly registered. Likewise, a valid conditional workflow (multiple outgoing edges with `condition`) compiles successfully but Runtime V1 returns `CONDITIONAL_ROUTING_UNSUPPORTED`. Neither is a compiler failure — both are Runtime *capability* limitations, checked once during preflight, before any node executes.

## Supported V1 features

- Deterministic, framework-neutral node executors registered explicitly against a `NodeRegistry`
- A built-in `final_output` executor (`createRuntimeV1Registry`) that returns `RunState.values` as the workflow's output
- Sequential, unconditional routing exactly as the compiler indexed it (`outgoingEdgesByNode`)
- In-memory execution only — no persistence
- JSON-safe state, requests, and results throughout
- A bounded step ceiling (`maxSteps`), defensive rather than load-bearing (Workflow Compiler V1 already rejects cycles)

## Unsupported V1 features

Conditional routing, model execution, agent execution, tool execution, approval waitpoints, evaluator execution, retries, replanning, persistence, durability, and parallel execution are all deliberately out of scope. Attempting any of them fails a specific, structured preflight check rather than partially executing.

## Node Registry

```ts
interface NodeRegistry {
  register(executor: NodeExecutor): void;
  has(kind: NodeKind): boolean;
  get(kind: NodeKind): NodeExecutor | undefined;
}
```

`createNodeRegistry()` builds a fresh, isolated registry — there is no module-level `Map`, no global singleton, and no filesystem/module scanning. `register` throws on a duplicate `kind` registration, since that is a programming-time invariant violation by trusted calling code, not an execution-time or user-input failure. Workflow *authors* can never register an executor: node `config` is inert JSON data until a trusted, code-registered executor interprets it (see [permission model](../security/permission-model.md) and the "Security" section below). `NodeKind` is imported from `@aao/contracts` (`NodeKindSchema`) — this package never redefines or drifts from the canonical kind enum.

`createRuntimeV1Registry()` is the only registry Runtime V1 wires up automatically, and it contains exactly one executor: `final_output`. Model, agent, tool, approval, and evaluator executors are never auto-registered — a workflow that reaches one of those kinds fails preflight rather than silently succeeding against a fake executor.

## Node Executor contract

```ts
interface NodeExecutor {
  kind: NodeKind;
  execute(context: NodeExecutionContext): Promise<NodeExecutionResult>;
}

interface NodeExecutionContext {
  runId: RunId;
  node: NodeDefinition;
  state: RunState;   // a defensively cloned snapshot, not a live reference
  step: number;
}

interface NodeExecutionResult {
  statePatch?: JsonObject;
  output?: JsonValue;
}
```

An executor never receives a writable reference to authoritative state and never mutates it directly — it proposes a `statePatch` and/or `output`; the Runtime validates and applies it. No Fastify, Worker, `process.env`, filesystem, database, MCP, model SDK, or company-specific service is injected into `NodeExecutionContext` — those are later, explicitly justified dependency contexts, not implicit ambient access.

Executor output is validated at the Runtime boundary (`node-result-validation.ts`) before it is trusted: an executor result must be a plain object containing only the known `statePatch`/`output` keys (`INVALID_NODE_RESULT` otherwise), and every value inside both must be JSON-safe — function values, `Date` instances, `Map`/`Set` instances, and other class instances are rejected even when they would otherwise look like an "empty object" to a naive structural check (`isJsonSafe` in `json-safety.ts` checks each object's prototype explicitly for this reason). A malformed `statePatch` specifically is `INVALID_STATE_PATCH`; every other malformed shape is `INVALID_NODE_RESULT`.

## Runtime preflight

Before the first node executes, `runPreflight` (`src/preflight.ts`) runs, in order:

1. **Compiled plan integrity** — cheap defensive checks (`RUNTIME_PREFLIGHT_FAILED`) that the plan's own indexes are internally consistent before any of them is trusted: every `nodesById` key matches the id of the node it stores; `entryNodeId` and every `terminalNodeId` resolve to an existing node; every outgoing edge is filed under its own `sourceNodeId` (and every incoming edge under its own `targetNodeId`); every edge's source and target resolve to existing nodes; `outgoingEdgesByNode` and `incomingEdgesByNode` represent the same edge set; every terminal node has zero outgoing edges; and every non-terminal node has at least one. The compiler already guarantees all of this for a real compiled plan; this protects the Runtime from a manually constructed or corrupted plan that nonetheless passed the schema check below. It does not re-run reachability, cycle, or condition-structure validation — that remains `@aao/workflow-dsl`'s responsibility, not the Runtime's.
2. **Conditional routing** (`CONDITIONAL_ROUTING_UNSUPPORTED`) — Runtime V1 does not evaluate `Edge.condition`. Any edge carrying a condition fails the whole run before node 1 executes.
3. **Unconditional routing arity** (`RUNTIME_PREFLIGHT_FAILED`) — only meaningful once conditions are known to be entirely absent: every non-terminal node must have exactly one outgoing edge. A compiler-valid conditional plan may have several outgoing edges on one node; that shape is rejected by check 2 above as a capability limitation, not flagged here as corruption.
4. **Registered node kinds** (`NODE_EXECUTOR_NOT_FOUND`) — every node kind present in the plan must have a registered executor.

Before preflight runs at all, `validateRuntimeInput` (`src/runtime-input-validation.ts`) validates the Runtime's own request boundary — a well-formed `runId`, a `RunState` matching `RunStateSchema` whose `runId` agrees with the request's `runId` (a mismatch is rejected, never silently rewritten), a `CompiledWorkflowPlan` matching `CompiledWorkflowPlanSchema` (exported by `@aao/workflow-dsl`, since the compiled plan is owned by that package), a registry that looks like a `NodeRegistry`, and a sane `maxSteps` if provided. Both this and preflight run before any node executes, so a rejected run invokes zero executors.

## State semantics

Runtime V1 uses the canonical `RunState` contract (`@aao/contracts`) with the smallest deterministic update rule:

- A `statePatch` performs a **shallow top-level merge** into `RunState.values`: each top-level key present in the patch fully replaces that key's prior value (nested objects are replaced wholesale, never recursively merged); every key absent from the patch is preserved.
- `revision` increments by exactly **one** for every accepted state-changing result. A node that returns no patch does **not** increment revision — an unchanged state is not a new state.
- State handed to an executor is a deep clone (`cloneRunState`); a returned patch is deep-cloned again before merging. Neither the caller's `initialState` nor any earlier snapshot derived from it is ever mutated by a later step.

No reducer registry, deep merge, delete operator, CRDT, conflict resolution, or persistence exists — all deliberately deferred to Sprint 5 (State, Run Lifecycle & Runtime State Management).

## Execution semantics

Execution starts at `plan.entryNodeId` and walks forward one node at a time: resolve the node, look up its executor, clone context, `await execute(context)`, validate the result, apply the state patch, record history, then either stop (if the node is one of `plan.terminalNodeIds`) or follow the plan's single indexed outgoing edge to the next node. There is no concurrency and no backtracking. A defensive `maxSteps` ceiling (default: node count + 5) exists purely as protection against a corrupted plan or a future Runtime bug — Workflow Compiler V1 already rejects cycles — and produces `MAX_STEPS_EXCEEDED` if exceeded, with no retry or replanning.

`final_output` is a minimal, generic completion executor: it returns `RunState.values` as the workflow's output and proposes no state patch. No field-selection DSL, templating, or response rendering exists — those are deferred until a real need is demonstrated.

## Failure model

| Code | Meaning |
| --- | --- |
| `INVALID_RUNTIME_INPUT` | The `ExecuteWorkflowRequest` itself is malformed: bad `runId`, a plan or state failing its schema, a `runId`/`initialState.runId` mismatch, a non-`NodeRegistry`-shaped registry, or an invalid `maxSteps`. |
| `RUNTIME_PREFLIGHT_FAILED` | The compiled plan is schema-valid but internally inconsistent for execution (unresolvable entry node, missing edge-index entries, terminal/non-terminal arity violations). |
| `NODE_EXECUTOR_NOT_FOUND` | A node kind present in the plan has no registered executor. |
| `CONDITIONAL_ROUTING_UNSUPPORTED` | The plan contains at least one edge with a `condition`. |
| `NODE_EXECUTION_FAILED` | A registered executor threw. The public failure carries only safe, deterministic metadata (`code`, a fixed generic message, `nodeId`, `step`) — the thrown value's `message`, its stack, the raw thrown value itself, and any environment/secret data it might contain are never exposed, regardless of what the executor threw. |
| `INVALID_NODE_RESULT` | An executor's return value is not a plain object with only `statePatch`/`output`, or `output` is not JSON-safe. |
| `INVALID_STATE_PATCH` | An executor's `statePatch` is not a JSON-safe plain object. |
| `MAX_STEPS_EXCEEDED` | Execution exceeded the bounded step ceiling. |

Every failure is a small, JSON-safe, deterministic object (`code`, `message`, optional `nodeId`/`step`/`details`) — free of stack traces, environment data, or secrets.

## Execution evidence

Each successful `WorkflowExecutionResult` carries a `history: NodeExecutionRecord[]` — `nodeId`, `kind`, `step`, `status: "SUCCEEDED"`, optional `output`, `stateRevisionBefore`, `stateRevisionAfter`. This is **not** the future canonical AAO Trace: no wall-clock latency, tokens, costs, timestamps, trace ids, or OpenTelemetry data appear here. It exists only so tests and a later tracing/observability layer have deterministic evidence that nodes ran in the expected order with the expected state effect.

## Security boundaries

The Runtime never `eval`s workflow data, executes JavaScript from node `config`, dynamically imports user-specified modules, executes shell commands, reads arbitrary filesystem paths, invokes external APIs, or reads credentials. Node `config` is inert JSON data until a trusted, code-registered executor interprets it; the Node Registry itself is code-controlled and workflow authors cannot register executors. Runtime V1 performs no side effects of any kind (no email, CRM, file, API, or calendar mutation) — there is no authorization/approval infrastructure yet to gate them.

## Future extension

A future model/agent/tool/approval/evaluator executor plugs in by implementing `NodeExecutor` for its kind and registering it against a `NodeRegistry` passed into `executeWorkflow` — no change to `engine.ts`'s orchestration, preflight, or state-application logic is required. Conditional routing, retries, persistence, and durable checkpointing are expected to extend the preflight/engine boundary in later sprints rather than replace it. See [ADR-009](../decisions/ADR-009-node-registry-and-runtime-v1.md) for what is deliberately deferred and why.
