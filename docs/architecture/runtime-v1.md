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
- In-memory execution by default; durable persistence is an opt-in host port (Sprint 14, `@aao/durability`)
- JSON-safe state, requests, and results throughout
- A bounded step ceiling (`maxSteps`), defensive rather than load-bearing (Workflow Compiler V1 already rejects cycles)

## Unsupported V1 features

Conditional routing, evaluator execution, replanning, and parallel execution remain out of scope. The `evaluator` node kind still has no executor. The Sprint 17 Evaluation Runtime (`@aao/evaluation`) is deliberately *outside* the Runtime: a host evaluates a Run's evidence after `executeWorkflow` returns. There is no `RuntimeOptions.eval`, and no evaluator can decide whether execution continues (ADR-022). Storage is outside this package: durability is a generic host port implemented by `@aao/durability`. Approval waitpoints are supported through a registered `@aao/approval` executor. Model execution exists since Sprint 6, but outside this package: `@aao/model-runtime` provides a `model` executor that callers register explicitly (see [model runtime](model-runtime.md)); without it, a model node still fails with `NODE_EXECUTOR_NOT_FOUND`. Bounded agent execution exists since Sprint 7, likewise outside this package: `@aao/agent-runtime` provides an `agent` executor that callers register explicitly (see [agent runtime](agent-runtime.md)); without it, an agent node fails with `NODE_EXECUTOR_NOT_FOUND`. Tool execution exists since Sprint 8, likewise outside this package: `@aao/tool-runtime` provides a `tool` executor that callers register explicitly (see [tool runtime](tool-runtime.md)); without it, a tool node fails with `NODE_EXECUTOR_NOT_FOUND`. Attempting any of them fails a specific, structured preflight check rather than partially executing.

## Node-specific static config validation

`NodeExecutor` may declare an optional, deterministic, side-effect-free `validateConfig({ node })` hook returning `{ ok: true }` or `{ ok: false, issues }`. Preflight calls it for every plan node (on a defensive clone), after registration checks and before any node executes; a rejection or a throw becomes `RUNTIME_PREFLIGHT_FAILED` (with `details.issues` only when the hook returned string issues — a thrown value is never exposed). Executors that omit the hook accept any JSON-safe config, as before. This is not a plugin lifecycle.

## Node Registry

```ts
interface NodeRegistry {
  register(executor: NodeExecutor): void;
  has(kind: NodeKind): boolean;
  get(kind: NodeKind): NodeExecutor | undefined;
}
```

`createNodeRegistry()` builds a fresh, isolated registry — there is no module-level `Map`, no global singleton, and no filesystem/module scanning. `register` throws on a duplicate `kind` registration, since that is a programming-time invariant violation by trusted calling code, not an execution-time or user-input failure. Workflow *authors* can never register an executor: node `config` is inert JSON data until a trusted, code-registered executor interprets it (see [permission model](../security/permission-model.md) and the "Security" section below). `NodeKind` is imported from `@aao/contracts` (`NodeKindSchema`) — this package never redefines or drifts from the canonical kind enum.

`createRuntimeV1Registry()` is the only registry Runtime V1 wires up automatically, and it contains exactly one executor: `final_output`. Model (`@aao/model-runtime`), agent (`@aao/agent-runtime`), tool (`@aao/tool-runtime`), approval, and evaluator executors are never auto-registered — a workflow that reaches one of those kinds fails preflight rather than silently succeeding against a fake executor.

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

type NodeExecutionResult =
  | { ok: true; statePatch?: JsonObject; output?: JsonValue }
  | { ok: false; failure: { namespace: string; code: string } }; // safe executor failure (Sprint 7)
```

An executor never receives a writable reference to authoritative state and never mutates it directly — it proposes a `statePatch` and/or `output`; the Runtime validates and applies it. No Fastify, Worker, `process.env`, filesystem, database, MCP, model SDK, or company-specific service is injected into `NodeExecutionContext` — those are later, explicitly justified dependency contexts, not implicit ambient access.

Executor output is validated at the Runtime boundary (`node-result-validation.ts`) before it is trusted: a success must be a plain object with `ok: true` and only the known `statePatch`/`output` keys (`INVALID_NODE_RESULT` otherwise), and every value inside both must be JSON-safe — function values, `Date` instances, `Map`/`Set` instances, and other class instances are rejected even when they would otherwise look like an "empty object" to a naive structural check (`isJsonSafe` in `json-safety.ts` checks each object's prototype explicitly for this reason). A malformed `statePatch` specifically is `INVALID_STATE_PATCH`; every other malformed shape is `INVALID_NODE_RESULT`.

### Safe executor-failure protocol (Sprint 7)

An executor that fails in an *expected* way returns `{ ok: false, failure: { namespace, code } }` instead of throwing. The shape is strict and bounded: `namespace` matches `^[a-z][a-z0-9_]{0,31}$`, `code` matches `^[A-Z][A-Z0-9_]{0,63}$`, and no other field (message, stack, exception, provider payload, nested metadata, or a `statePatch` alongside it) is accepted — anything else is `INVALID_NODE_RESULT`. A valid failure marks the node `FAILED` and the Run `FAILED`, applies no patch, leaves downstream nodes `PENDING`, and returns the generic `NODE_EXECUTION_FAILED` with the pair carried as subordinate `executorFailure`. The Runtime never interprets the pair — it does not know what `model`, `agent`, or `tool` means; `@aao/model-runtime` reports `{ namespace: "model", code: <ModelFailureCode> }`, `@aao/agent-runtime` reports `{ namespace: "agent", code: <AgentFailureCode> }`, and `@aao/tool-runtime` reports `{ namespace: "tool", code: <ToolFailureCode> }`.

Throwing remains supported as defensive protection, but a thrown value is never inspected or parsed: it always becomes `NODE_EXECUTION_FAILED` with a fixed generic message and **no** `executorFailure`. Specific subordinate codes come only through the validated failure-result protocol.

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

No reducer registry, deep merge, delete operator, CRDT, conflict resolution, or persistence exists — this shallow-patch policy remains deliberate V1 state-management policy (see [runtime state management](runtime-state-management.md) and [ADR-010](../decisions/ADR-010-managed-runtime-state-and-lifecycle.md)), not a placeholder awaiting a later sprint.

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
| `NODE_EXECUTION_FAILED` | A registered executor threw, or returned a validated safe executor failure. The public failure carries only safe, deterministic metadata (`code`, a fixed generic message, `nodeId`, `step`, and — only for a returned failure — `executorFailure: { namespace, code }`). A thrown value's `message`, its stack, the raw thrown value itself, and any environment/secret data it might contain are never exposed, regardless of what the executor threw. |
| `INVALID_NODE_RESULT` | An executor's return value is not `{ ok: true, statePatch?, output? }` or a bounded `{ ok: false, failure: { namespace, code } }`, or `output` is not JSON-safe. |
| `INVALID_STATE_PATCH` | An executor's `statePatch` is not a JSON-safe plain object. |
| `MAX_STEPS_EXCEEDED` | Execution exceeded the bounded step ceiling. |
| `INVALID_EXECUTION_SNAPSHOT` | A `RuntimeExecutionSnapshot` (see [runtime state management](runtime-state-management.md)) fails schema validation or is contextually incompatible with a given `CompiledWorkflowPlan` (returned by `validateSnapshotAgainstPlan`, not by `executeWorkflow` itself). |

Every failure is a small, JSON-safe, deterministic object (`code`, `message`, optional `nodeId`/`step`/`details`/`executorFailure`) — free of stack traces, environment data, or secrets.

## Execution evidence

Every `WorkflowExecutionResult` (success or a managed failure) carries `execution.history: NodeExecutionRecord[]` — `nodeId`, `kind`, `step`, `status: "SUCCEEDED" | "FAILED"`, optional `output`, `stateRevisionBefore`, `stateRevisionAfter`. A `FAILED` record's `stateRevisionBefore` always equals `stateRevisionAfter`: no state patch is ever applied from a node that threw or returned an invalid result. This is **not** the future canonical AAO Trace: no wall-clock latency, tokens, costs, timestamps, trace ids, or OpenTelemetry data appear here. It exists only so tests and a later tracing/observability layer have deterministic evidence that nodes ran (or failed to run) in the expected order with the expected state effect. See [runtime state management](runtime-state-management.md) for the full managed execution shape (`RuntimeExecutionState`, Run/Node lifecycle, and safe execution snapshots) this history is now part of.

## Security boundaries

The Runtime never `eval`s workflow data, executes JavaScript from node `config`, dynamically imports user-specified modules, executes shell commands, reads arbitrary filesystem paths, invokes external APIs, or reads credentials. Node `config` is inert JSON data until a trusted, code-registered executor interprets it; the Node Registry itself is code-controlled and workflow authors cannot register executors. Runtime V1 performs no side effects of any kind (no email, CRM, file, API, or calendar mutation). Tool authorization exists since Sprint 9, outside this package (`@aao/authorization`, enforced by `@aao/tool-runtime`), and process-local approval waitpoints exist, while side-effecting Tool classes stay unsupported.

## Future extension

Model, Agent, Tool, and Approval executors implement `NodeExecutor` and are explicitly registered against the `NodeRegistry` passed into `executeWorkflow`; evaluator remains future. Approval waitpoints added one generic control result and continuation to the shared `engine.ts` loop. Retries (Sprint 13) and durable checkpointing (Sprint 14) extended the preflight/engine boundary rather than replacing it; conditional routing is expected to do the same. See [ADR-009](../decisions/ADR-009-node-registry-and-runtime-v1.md) for what is deliberately deferred and why.

`executeWorkflow` is now a *managed* execution: it builds and returns an authoritative `RuntimeExecutionState` (Run lifecycle, Node lifecycle, revisioned state, execution history) and a safe `RuntimeExecutionSnapshot` at every safe boundary, rather than only a final result. See [runtime state management](runtime-state-management.md) and [ADR-010](../decisions/ADR-010-managed-runtime-state-and-lifecycle.md) for the full model this section's pipeline now executes inside of.

## Sprint 12 approval boundary

An explicitly registered Approval Node now returns a bounded Runtime wait result. The Run enters `WAITING_FOR_APPROVAL`, the Approval Node enters `WAITING`, and downstream nodes remain pending. The version-2 safe snapshot includes an approval reference and fingerprint. A trusted host may resolve the process-local Approval and invoke validated in-process continuation through the same Runtime loop. Approval only confirms the exact request; Governance, Authorization, Agent ceilings, and Tool Runtime support still apply. See [approval engine](approval-engine.md) and [ADR-017](../decisions/ADR-017-human-approval-and-runtime-waitpoints.md).

## Sprint 13 reliability boundary

`runLoop` now executes each Node through one internal Reliability Controller. The default is one attempt, so behavior is unchanged without a policy. A trusted host may set `RuntimeOptions.reliability.policiesByNodeId` (hard-capped `maxAttempts ≤ 3`, `attemptTimeoutMs`, `retryDelayMs`) and inject a `RuntimeSleeper`. A retry happens only when a structured retryable failure category meets a retry-safe executor declaration and remaining budget. `NodeExecutionContext` gains `attempt` and a cooperative `AbortSignal`; history records gain `attemptCount`/`attemptFailures`; failures gain `category`, `retryable`, `attempt`, and `maxAttempts`, plus `NODE_ATTEMPT_TIMEOUT` and `NODE_RETRY_EXHAUSTED`. See [reliability runtime](reliability-runtime.md) and [ADR-018](../decisions/ADR-018-runtime-reliability-and-bounded-retries.md).

## Sprint 14 durability boundary

The Runtime gains a generic durability port, `RuntimeOptions.durability`, with four methods:

- `persistCheckpoint`: persist a safe boundary.
- `beginAttempt`: write-ahead intent before every executor attempt.
- `recordAttemptOutcome`: persist the validated outcome before any commit or retry.
- `isCancellationRequested`: checked only at safe boundaries.

It also gains one resume primitive, `resumeWorkflow({ plan, registry, execution, recovery?, options })`. Both enter the same `runLoop` and commit path as `executeWorkflow` and `continueWaitingWorkflow`; there is no second loop. A rejected hook stops execution with `DURABILITY_PERSISTENCE_FAILED` at the last durably persisted boundary. A `NodeRecoveryDirective` supplies the current Node's recorded attempt outcomes and an optional replay attempt. Its rules:

- A recorded accepted outcome commits without invoking the executor.
- Recorded failures keep attempt numbering and the retry budget.
- An inconsistent directive is `INVALID_RECOVERY_DIRECTIVE`.

Safe-boundary cancellation adds `READY → CANCELLED` and `RUN_CANCELLED`, and resuming a terminal Run is `RUN_ALREADY_TERMINAL` with nothing executed. The Runtime never loads or stores anything; `@aao/durability` does. Without the port, behavior is unchanged. See [durable execution](durable-execution.md) and [ADR-019](../decisions/ADR-019-durable-execution-checkpoints-and-replay.md).

## Trace port (Sprint 15)

`RuntimeOptions.trace` is an optional, emit-only `RuntimeTracePort`. The Runtime reports:

- `run.started` when a Run is created;
- `node.started`, `retry.scheduled`, and `retry.exhausted` as attempts happen;
- `state.updated` (key names only), `node.completed`, `node.failed`, `node.waiting`, `route.selected`, and the terminal Run event after each boundary commits (in durable mode, after it is persisted).

Executors receive a per-attempt `NodeTraceContext` that closes when the Runtime stops waiting for the attempt, so late results never become evidence. A missing, throwing, or rejecting port never changes execution, and the untraced path is unchanged. History stays the Runtime's own evidence. See [trace runtime](trace-runtime.md) and [ADR-020](../decisions/ADR-020-trace-runtime-and-observability-boundary.md).
