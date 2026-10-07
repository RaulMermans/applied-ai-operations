import type { FailureCategory, JsonObject, JsonValue, NodeDefinition, NodeId, NodeKind, ReliabilityPolicy, RetrySafety, RunId, RunRecord, RunState } from "@aao/contracts";
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
  /**
   * Optional, deterministic, side-effect-free static validation of one
   * node's `config`, called by Runtime preflight for every plan node of this
   * kind *before any node executes*. Executors that omit it accept any
   * JSON-safe config (the Runtime V1 default). A thrown error is treated as
   * a failed validation, never propagated.
   */
  validateConfig?(context: NodePreflightContext): NodePreflightResult;
  /**
   * Optional, trusted, deterministic retry-safety declaration for one node
   * (ADR-018). Absent, thrown, or anything other than `"safe"` means
   * `"unsafe"`: the Runtime never retries the node, whatever the policy.
   * Never derived from model output, workflow state, or failure messages.
   */
  retrySafety?(context: NodePreflightContext): RetrySafety;
  execute(context: NodeExecutionContext): Promise<NodeExecutionResult>;
}

/** What `NodeExecutor.validateConfig` sees: a defensive clone of the node definition, and nothing else — no state, registry, or clock. */
export interface NodePreflightContext {
  node: NodeDefinition;
}

/** A static config-validation verdict. `issues` are short, deterministic, JSON-safe descriptions of what is wrong with the node's static config. */
export type NodePreflightResult = { ok: true } | { ok: false; issues: string[] };

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
  /** 1-based Runtime attempt number within this Node execution. Every attempt receives the same authoritative input state. */
  attempt: number;
  /** Aborted when the Runtime abandons this attempt (timeout). Cooperative and best-effort: a late result is ignored either way. */
  signal: AbortSignal;
}

/** Serializable coordination metadata; the RunRecord remains lifecycle truth. */
export interface RuntimeWaitState {
  kind: "approval";
  nodeId: NodeId;
  referenceId: string;
  requestFingerprint: string;
}

/**
 * A safe, machine-readable reason a trusted executor reports when it fails
 * in an *expected* way (e.g. its subsystem returned a deterministic failure
 * value). Deliberately tiny and opaque to the Runtime: `namespace` names the
 * reporting subsystem (e.g. `model`, `agent`) and `code` is that subsystem's
 * own failure code. The Runtime validates the shape (see
 * `node-result-validation.ts`) but never interprets either value — it does
 * not know what `"model"` or `"agent"` means. No message, stack, exception,
 * provider payload, or nested metadata is accepted.
 */
export interface NodeExecutorFailure {
  namespace: string;
  code: string;
  /**
   * Optional structured classification from the trusted executor. Absent
   * means `EXECUTION` (non-retryable): unknown failures fail closed.
   */
  category?: FailureCategory;
}

/**
 * What an executor returns instead of mutating state directly — a
 * discriminated union on `ok`:
 *
 * - `{ ok: true, statePatch?, output? }` — success. The Runtime — not the
 *   executor — validates and applies the patch. Both fields are optional: a
 *   node may produce output with no state change, a state change with no
 *   reportable output, neither, or both.
 * - `{ ok: false, failure: { namespace, code } }` — an expected, safe
 *   executor failure. The Runtime marks the node `FAILED`, applies no patch,
 *   and reports its own generic `NODE_EXECUTION_FAILED` carrying the
 *   validated `failure` as subordinate `executorFailure` causality.
 *
 * Throwing remains supported as a defensive path, but a thrown value is
 * never inspected: it always becomes a generic `NODE_EXECUTION_FAILED` with
 * no `executorFailure`.
 */
export type NodeExecutionResult =
  | { ok: true; statePatch?: JsonObject; output?: JsonValue }
  | { ok: true; wait: { kind: "approval"; referenceId: string; requestFingerprint: string } }
  | { ok: false; failure: NodeExecutorFailure };

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
  /**
   * Trusted, host-supplied reliability configuration (ADR-018). Workflow
   * source, workflow state, and executor output can never reach it. Nodes
   * without a policy get the default single attempt.
   */
  reliability?: RuntimeReliabilityOptions;
  /** The Runtime's explicit delay boundary for timeouts and retry delays. Defaults to `createSystemSleeper()`; tests inject a deterministic one. */
  sleeper?: RuntimeSleeper;
}

export interface RuntimeReliabilityOptions {
  policiesByNodeId?: Record<NodeId, ReliabilityPolicy>;
}

/**
 * Resolves after `ms`, or promptly once `signal` aborts. The Runtime always
 * aborts a timer it no longer needs, so no timer outlives its attempt.
 */
export interface RuntimeSleeper {
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
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

export interface ContinueWaitingWorkflowRequest {
  plan: CompiledWorkflowPlan;
  registry: NodeRegistry;
  execution: RuntimeExecutionState;
  approval: { approvalId: string; runId: string; nodeId: string; requestFingerprint: string; status: "pending" | "approved" | "rejected" | "expired" | "cancelled" };
  /** Independently recomputed by the trusted approval host from the current subject. */
  currentRequestFingerprint: string;
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
  /** Executor invocations made for this Node execution (Runtime metadata, never business state). */
  attemptCount: number;
  /** One bounded entry per failed attempt, in order; absent when no attempt failed. */
  attemptFailures?: NodeAttemptFailure[];
}

export interface NodeAttemptFailure {
  attempt: number;
  category: FailureCategory;
  /** The attempt's executor failure code, or the Runtime failure code when no executor code exists. */
  causeCode: string;
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
  wait?: RuntimeWaitState;
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
  | "NODE_ATTEMPT_TIMEOUT"
  | "NODE_RETRY_EXHAUSTED"
  | "INVALID_EXECUTION_SNAPSHOT"
  | "INVALID_APPROVAL_CONTEXT"
  | "APPROVAL_STILL_PENDING"
  | "APPROVAL_REQUEST_MISMATCH"
  | "APPROVAL_REJECTED"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_CANCELLED";

export interface RuntimeFailure {
  code: RuntimeFailureCode;
  message: string;
  nodeId?: NodeId;
  step?: number;
  details?: JsonObject;
  /**
   * Present only on `NODE_EXECUTION_FAILED` when the executor *returned* a
   * validated `{ ok: false, failure }` result — subordinate, bounded,
   * machine-readable causality (e.g. `{ namespace: "model", code:
   * "MODEL_ROUTE_NOT_FOUND" }`). Never present for a thrown executor.
   */
  executorFailure?: NodeExecutorFailure;
  /** Reliability envelope, present on every Node execution failure. `retryable` describes the failure's nature, not whether a retry occurred. */
  category?: FailureCategory;
  retryable?: boolean;
  attempt?: number;
  maxAttempts?: number;
  /** On `NODE_RETRY_EXHAUSTED` only: the last attempt's bounded underlying code. */
  causeCode?: string;
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
