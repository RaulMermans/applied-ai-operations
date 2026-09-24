import type { JsonObject, JsonValue, NodeDefinition, NodeId, NodeKind, RunId, RunRecord, RunState } from "@aao/contracts";
import type { CompiledWorkflowPlan } from "@aao/workflow-dsl";
import type { RuntimeClock } from "./clock.js";
import type { NodeStatusMap } from "./node-lifecycle.js";
import type { RuntimeExecutionSnapshot } from "./execution-snapshot.js";

// --- Node Registry ----------------------------------------------------------

/**
 * A trusted, code-registered handler for one canonical `NodeKind`. Node kinds
 * come from `@aao/contracts` (`NodeKindSchema`) — this package never defines
 * its own kind union, which would risk drifting from canonical AAO semantics.
 * Workflow authors cannot register executors; only trusted application code
 * calling `NodeRegistry.register` can.
 */
export interface NodeExecutor {
  kind: NodeKind;
  execute(context: NodeExecutionContext): Promise<NodeExecutionResult>;
}

/**
 * Everything an executor currently needs to do its job, and nothing more. No
 * Fastify, Worker, process.env, filesystem, database, MCP, model SDK, or
 * company-specific service is injected — those are later, justified runtime
 * dependency contexts. `state` is a defensively cloned snapshot: executors
 * cannot corrupt authoritative state through shared references, only propose
 * a patch via their return value.
 */
export interface NodeExecutionContext {
  runId: RunId;
  node: NodeDefinition;
  state: RunState;
  step: number;
}

/**
 * What an executor returns instead of mutating state directly: a proposed
 * state patch and/or an output value. The Runtime — not the executor —
 * validates and applies the patch. Both fields are optional: a node may
 * produce output with no state change, a state change with no reportable
 * output, neither (a pure side-effect-free no-op in V1, since V1 has no real
 * side effects), or both.
 */
export interface NodeExecutionResult {
  statePatch?: JsonObject;
  output?: JsonValue;
}

/**
 * Explicit, constructible, isolated Node Registry. There is no global
 * singleton and no filesystem/module scanning: every instance starts empty
 * and is populated only by trusted calling code via `register`.
 */
export interface NodeRegistry {
  /** Registers an executor for its `kind`. Throws if that kind is already registered — duplicate registrations are a programming error, not a runtime/user-input failure. */
  register(executor: NodeExecutor): void;
  has(kind: NodeKind): boolean;
  get(kind: NodeKind): NodeExecutor | undefined;
}

// --- Runtime request ---------------------------------------------------------

export interface RuntimeOptions {
  /**
   * A hard ceiling on the number of nodes executed in one run. Defaults to a
   * small bounded allowance over the plan's node count (see `engine.ts`).
   * Exists purely as defensive protection against corrupted plans or future
   * runtime bugs — Workflow Compiler V1 already rejects cycles.
   */
  maxSteps?: number;
  /**
   * The Runtime's explicit time boundary (see `clock.ts`). Every Run
   * lifecycle timestamp and snapshot `capturedAt` comes from this clock.
   * Defaults to a real system clock (`createSystemClock()`); tests inject a
   * deterministic one so lifecycle timestamps are assertable.
   */
  clock?: RuntimeClock;
}

/**
 * The Runtime's caller-facing request shape. `runId` is always
 * caller-provided (never generated inside the engine) so tests stay
 * deterministic and a future Control Plane/persistence layer keeps ownership
 * of run identity. `plan` is a `CompiledWorkflowPlan` — the Runtime never
 * parses workflow source itself.
 */
export interface ExecuteWorkflowRequest {
  runId: RunId;
  plan: CompiledWorkflowPlan;
  initialState: RunState;
  registry: NodeRegistry;
  options?: RuntimeOptions;
}

// --- Runtime result -----------------------------------------------------------

/**
 * Minimal, JSON-safe, per-node execution evidence. This is *not* the future
 * canonical AAO Trace — no wall-clock latency, tokens, costs, timestamps,
 * trace ids, or OpenTelemetry. It exists so tests and a later tracing layer
 * have deterministic evidence that nodes ran (or failed to run) in the
 * expected order with the expected state effect. A `FAILED` record's
 * `stateRevisionBefore`/`stateRevisionAfter` are always equal: no state
 * patch is ever applied from a node that threw or returned an invalid
 * result, so a failed node never advances the revision.
 */
export interface NodeExecutionRecord {
  nodeId: NodeId;
  kind: NodeKind;
  step: number;
  status: "SUCCEEDED" | "FAILED";
  output?: JsonValue;
  stateRevisionBefore: number;
  stateRevisionAfter: number;
}

/**
 * The Runtime-owned, JSON-safe managed execution state for one Run — the
 * single authoritative representation `docs/architecture/runtime-state-management.md`
 * describes. `run` is the sole source of Run lifecycle truth (`RunRecord`,
 * from `@aao/contracts`); `nodeStatusesById` is the sole source of Node
 * lifecycle truth; `state` is the sole source of authoritative workflow
 * data. Deliberately excludes the Node Registry, executors, the clock, and
 * any other live Runtime dependency — those are inputs to execution, not
 * part of its serializable state.
 */
export interface RuntimeExecutionState {
  run: RunRecord;
  state: RunState;
  nodeStatusesById: NodeStatusMap;
  step: number;
  history: NodeExecutionRecord[];
}

/**
 * The small Runtime V1 failure taxonomy. Every code here is deterministic,
 * JSON-safe, machine-readable, and free of environment/secret data — no raw
 * stack trace is ever exposed through this shape.
 */
export type RuntimeFailureCode =
  | "INVALID_RUNTIME_INPUT"
  | "RUNTIME_PREFLIGHT_FAILED"
  | "NODE_EXECUTOR_NOT_FOUND"
  | "CONDITIONAL_ROUTING_UNSUPPORTED"
  | "NODE_EXECUTION_FAILED"
  | "INVALID_NODE_RESULT"
  | "INVALID_STATE_PATCH"
  | "MAX_STEPS_EXCEEDED"
  | "INVALID_EXECUTION_SNAPSHOT";

export interface RuntimeFailure {
  code: RuntimeFailureCode;
  message: string;
  nodeId?: NodeId;
  step?: number;
  details?: JsonObject;
}

/**
 * The Runtime's public result shape. Expected failures (bad input, preflight
 * rejection, an executor throwing, a malformed result) are values, never
 * exceptions — only unexpected internal invariant violations may still
 * throw. `RunRecord.status` (inside `execution.run`) is the sole source of
 * lifecycle truth — there is no separate top-level `status` field to drift
 * out of sync with it (see ADR-010).
 *
 * A request rejected by `validateRuntimeInput` (`INVALID_RUNTIME_INPUT`)
 * carries no `execution`/`latestSnapshot`: the request could not be trusted
 * enough to construct a `RunRecord` in the first place. Every failure after
 * that point (preflight, node execution, malformed result, step ceiling)
 * carries both, so a failure is always inspectable at its last safe
 * execution boundary.
 */
export type WorkflowExecutionResult =
  | { ok: true; execution: RuntimeExecutionState; output?: JsonValue; latestSnapshot: RuntimeExecutionSnapshot }
  | { ok: false; failure: RuntimeFailure; execution?: RuntimeExecutionState; latestSnapshot?: RuntimeExecutionSnapshot };
