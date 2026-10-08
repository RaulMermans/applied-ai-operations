import { ReliabilityPolicySchema, isRetryableFailureCategory, type FailureCategory, type JsonObject, type JsonValue, type NodeDefinition, type NodeId, type ReliabilityPolicy, type RunId, type RunState } from "@aao/contracts";
import type { CompiledWorkflowPlan } from "@aao/workflow-dsl";
import { isJsonSafe } from "./json-safety.js";
import { validateNodeExecutionResult } from "./node-result-validation.js";
import { cloneRunState } from "./state.js";
import type { NodeAttemptFailure, NodeAttemptIntent, NodeAttemptOutcome, NodeExecutor, NodeExecutorFailure, NodeRecoveryDirective, RuntimeDurabilityHooks, RuntimeFailure, RuntimeOptions, RuntimeSleeper, RuntimeWaitState } from "./types.js";

/**
 * Runtime Reliability Controller (ADR-018, docs/architecture/reliability-runtime.md).
 * It manages the attempts of exactly one Node execution inside the single
 * Runtime loop; it is not a second execution engine. It never applies state,
 * transitions lifecycle, or routes — it returns at most one accepted outcome
 * and the Runtime commits it.
 *
 * A retry happens only when all three hold: the trusted policy permits
 * another attempt, the failure's structured category is retryable
 * (`TIMEOUT`, `TRANSIENT_DEPENDENCY`, `RATE_LIMIT`), and the executor
 * declared this node `"safe"`. Messages and thrown values are never read.
 */

export const DEFAULT_RELIABILITY_POLICY: Readonly<ReliabilityPolicy> = Object.freeze({ maxAttempts: 1 });

/** The production delay boundary: a platform timer that is cleared as soon as `signal` aborts. */
export function createSystemSleeper(): RuntimeSleeper {
  return {
    sleep(ms: number, signal?: AbortSignal): Promise<void> {
      return new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, ms);
        function onAbort() {
          clearTimeout(timer);
          resolve();
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

export interface ResolvedReliability {
  policyFor(nodeId: NodeId): Readonly<ReliabilityPolicy>;
  sleeper: RuntimeSleeper;
}

/**
 * Validates trusted reliability options against the plan once, before any
 * Node runs: JSON-safe, schema-valid, hard-capped policies keyed only by plan
 * Node IDs, and never a multi-attempt policy on an Approval Node (a wait is
 * not a failure and is never retried). Parsed policies are frozen copies.
 */
export function resolveReliability(options: RuntimeOptions | undefined, plan: CompiledWorkflowPlan): { ok: true; reliability: ResolvedReliability } | { ok: false; failure: RuntimeFailure } {
  const invalid = (message: string) => ({ ok: false as const, failure: { code: "INVALID_RUNTIME_INPUT" as const, message } });
  const sleeper = options?.sleeper ?? createSystemSleeper();
  if (typeof sleeper !== "object" || sleeper === null || typeof sleeper.sleep !== "function") return invalid("request.options.sleeper must implement sleep(ms, signal).");

  const policies = new Map<NodeId, Readonly<ReliabilityPolicy>>();
  const reliability = options?.reliability;
  if (reliability !== undefined) {
    if (!isPlainObject(reliability) || !isJsonSafe(reliability) || Object.keys(reliability).some((key) => key !== "policiesByNodeId")) return invalid("request.options.reliability must be a JSON-safe object with only policiesByNodeId.");
    const byNode = reliability.policiesByNodeId;
    if (byNode !== undefined) {
      if (!isPlainObject(byNode)) return invalid("request.options.reliability.policiesByNodeId must be an object.");
      for (const [nodeId, raw] of Object.entries(byNode)) {
        const node = plan.nodesById[nodeId];
        if (node === undefined) return invalid(`Reliability policy references unknown node "${nodeId}".`);
        const parsed = ReliabilityPolicySchema.safeParse(raw);
        if (!parsed.success) return invalid(`Reliability policy for node "${nodeId}" is invalid or exceeds Runtime hard limits.`);
        if (node.kind === "approval" && parsed.data.maxAttempts > 1) return invalid(`Approval node "${nodeId}" cannot have a retry policy.`);
        policies.set(nodeId, Object.freeze({ ...parsed.data }));
      }
    }
  }
  return { ok: true, reliability: { sleeper, policyFor: (nodeId) => policies.get(nodeId) ?? DEFAULT_RELIABILITY_POLICY } };
}

export type NodeAttemptsOutcome =
  | { kind: "success"; statePatch?: JsonObject; output?: JsonValue; attemptCount: number; attemptFailures: NodeAttemptFailure[] }
  | { kind: "wait"; wait: Omit<RuntimeWaitState, "nodeId">; attemptCount: number; attemptFailures: NodeAttemptFailure[] }
  | { kind: "failure"; failure: RuntimeFailure; attemptCount: number; attemptFailures: NodeAttemptFailure[] }
  /** A durability hook rejected: nothing past the last durable boundary may be committed. */
  | { kind: "durability_failure" }
  | { kind: "invalid_recovery"; message: string };

interface AttemptFailure {
  code: RuntimeFailure["code"];
  category: FailureCategory;
  message: string;
  executorFailure?: NodeExecutorFailure;
}

type AttemptSettlement = { kind: "returned"; value: unknown } | { kind: "threw" } | { kind: "timeout" };

/**
 * Runs the bounded attempt sequence for one Node. Every attempt receives a
 * fresh defensive clone of the same authoritative input state, so a failed
 * or abandoned attempt can never influence the next one or commit anything.
 *
 * With durability hooks (ADR-019) each attempt is bracketed: intent is
 * persisted before the executor is eligible, and the Runtime-validated
 * outcome is persisted before anything is committed or retried. With a
 * recovery directive, durably recorded outcomes are replayed through the
 * same classification and retry decision — an accepted outcome is returned
 * without invoking the executor, and recorded failures keep attempt
 * numbering and the `maxAttempts` budget across restarts.
 */
export async function executeNodeAttempts(params: {
  runId: RunId;
  node: NodeDefinition;
  executor: NodeExecutor;
  state: RunState;
  step: number;
  policy: Readonly<ReliabilityPolicy>;
  sleeper: RuntimeSleeper;
  hooks?: RuntimeDurabilityHooks;
  recovery?: Pick<NodeRecoveryDirective, "priorOutcomes" | "replayAttempt">;
}): Promise<NodeAttemptsOutcome> {
  const { runId, node, executor, state, step, policy, sleeper, hooks, recovery } = params;
  const maxAttempts = policy.maxAttempts;
  const retrySafe = maxAttempts > 1 && resolveRetrySafety(executor, node);
  const attemptFailures: NodeAttemptFailure[] = [];

  /** The single retry decision: undefined means "try again", otherwise the Node's final failure. */
  const decide = (attempt: number, failed: AttemptFailure): NodeAttemptsOutcome | undefined => {
    attemptFailures.push({ attempt, category: failed.category, causeCode: failed.executorFailure?.code ?? failed.code });
    const retryable = isRetryableFailureCategory(failed.category);
    if (retryable && retrySafe && attempt < maxAttempts) return undefined;
    const exhausted = retryable && retrySafe && attempt >= maxAttempts;
    const failure: RuntimeFailure = {
      code: exhausted ? "NODE_RETRY_EXHAUSTED" : failed.code,
      message: exhausted ? `Node "${node.id}" (kind "${node.kind}") failed all ${maxAttempts} attempts.` : failed.message,
      nodeId: node.id,
      step,
      ...(failed.executorFailure ? { executorFailure: failed.executorFailure } : {}),
      category: failed.category,
      retryable,
      attempt,
      maxAttempts,
      ...(exhausted ? { causeCode: failed.executorFailure?.code ?? failed.code } : {}),
    };
    return { kind: "failure", failure, attemptCount: attempt, attemptFailures };
  };
  const accepted = (outcome: Exclude<NodeAttemptOutcome, { kind: "failure" }>, attempt: number): NodeAttemptsOutcome =>
    outcome.kind === "wait"
      ? { kind: "wait", wait: { ...outcome.wait }, attemptCount: attempt, attemptFailures }
      : { kind: "success", ...(outcome.statePatch !== undefined ? { statePatch: outcome.statePatch } : {}), ...(outcome.output !== undefined ? { output: outcome.output } : {}), attemptCount: attempt, attemptFailures };

  // Durably recorded attempts are replayed through the same decision, never re-executed.
  let attempt = 1;
  const prior = recovery?.priorOutcomes ?? [];
  for (const [index, outcome] of prior.entries()) {
    const recorded = index + 1;
    const last = index === prior.length - 1;
    if (outcome.kind !== "failure") {
      if (!last || recovery?.replayAttempt !== undefined) return { kind: "invalid_recovery", message: "An accepted outcome must be the last recorded attempt." };
      if (outcome.kind === "wait" && node.kind !== "approval") return { kind: "invalid_recovery", message: "Only an approval node may have a recorded wait." };
      return accepted(outcome, recorded);
    }
    const final = decide(recorded, outcome);
    if (final !== undefined) {
      if (!last || recovery?.replayAttempt !== undefined) return { kind: "invalid_recovery", message: "Recorded attempts continue past a final failure under the current reliability policy." };
      return final;
    }
    attempt = recorded + 1;
  }
  const replayAttempt = recovery?.replayAttempt;
  if (replayAttempt !== undefined && replayAttempt !== attempt) return { kind: "invalid_recovery", message: "The replayed attempt must directly follow the recorded attempts." };
  if (prior.length > 0 && replayAttempt === undefined && policy.retryDelayMs !== undefined && policy.retryDelayMs > 0) await sleeper.sleep(policy.retryDelayMs);

  for (; ; attempt += 1) {
    const intent: NodeAttemptIntent = { runId, nodeId: node.id, kind: node.kind, step, stateRevision: state.revision, attempt, maxAttempts, recoveryReplay: attempt === replayAttempt };
    // Write-ahead: if intent cannot be persisted, the executor never becomes eligible.
    if (hooks) {
      try { await hooks.beginAttempt({ ...intent }); } catch { return { kind: "durability_failure" }; }
    }
    const settlement = await runAttempt(executor, sleeper, policy.attemptTimeoutMs, { runId, node: cloneNodeDefinition(node), state: cloneRunState(state), step, attempt });

    let outcome: NodeAttemptOutcome;
    if (settlement.kind === "timeout") {
      outcome = { kind: "failure", code: "NODE_ATTEMPT_TIMEOUT", category: "TIMEOUT", message: `Node "${node.id}" (kind "${node.kind}") attempt ${attempt} exceeded its ${policy.attemptTimeoutMs} ms timeout.` };
    } else if (settlement.kind === "threw") {
      // Deliberately generic: the thrown value is never inspected or exposed.
      outcome = { kind: "failure", code: "NODE_EXECUTION_FAILED", category: "INTERNAL", message: `Node "${node.id}" (kind "${node.kind}") threw during execution.` };
    } else {
      const validated = validateNodeExecutionResult(settlement.value);
      if (!validated.ok) {
        outcome = { kind: "failure", code: validated.code, category: "VALIDATION", message: `Node "${node.id}": ${validated.message}` };
      } else if (!validated.result.ok) {
        const executorFailure = { ...validated.result.failure };
        outcome = { kind: "failure", code: "NODE_EXECUTION_FAILED", category: executorFailure.category ?? "EXECUTION", message: `Node "${node.id}" (kind "${node.kind}") reported an executor failure.`, executorFailure };
      } else if ("wait" in validated.result) {
        outcome = node.kind === "approval" ? { kind: "wait", wait: { ...validated.result.wait } } : { kind: "failure", code: "INVALID_NODE_RESULT", category: "VALIDATION", message: "Only an approval node may request an approval wait." };
      } else {
        const { statePatch, output } = validated.result;
        outcome = { kind: "success", ...(statePatch !== undefined ? { statePatch } : {}), ...(output !== undefined ? { output } : {}) };
      }
    }

    // Outcome-first: only a validated outcome is persisted, and only after it is durable may anything commit or retry.
    if (hooks) {
      try { await hooks.recordAttemptOutcome({ ...intent }, JSON.parse(JSON.stringify(outcome)) as NodeAttemptOutcome); } catch { return { kind: "durability_failure" }; }
    }
    if (outcome.kind !== "failure") return accepted(outcome, attempt);
    const final = decide(attempt, outcome);
    if (final !== undefined) return final;
    if (policy.retryDelayMs !== undefined && policy.retryDelayMs > 0) await sleeper.sleep(policy.retryDelayMs);
  }
}

/**
 * One executor invocation, optionally raced against the per-attempt timeout.
 * Late-result protection is structural: only the race winner is returned,
 * so a timed-out invocation that settles later resolves into a value nothing
 * reads — it can never reach validation, state, lifecycle, or output.
 */
async function runAttempt(executor: NodeExecutor, sleeper: RuntimeSleeper, timeoutMs: number | undefined, context: { runId: RunId; node: NodeDefinition; state: RunState; step: number; attempt: number }): Promise<AttemptSettlement> {
  const cancellation = new AbortController();
  const invocation: Promise<AttemptSettlement> = (async () => {
    try {
      return { kind: "returned", value: await executor.execute({ ...context, signal: cancellation.signal }) };
    } catch {
      return { kind: "threw" };
    }
  })();
  if (timeoutMs === undefined) return invocation;

  const timer = new AbortController();
  // A failing sleeper fails closed as a timeout; it can never be mistaken for success.
  const timeout: Promise<AttemptSettlement> = Promise.resolve()
    .then(() => sleeper.sleep(timeoutMs, timer.signal))
    .then(() => ({ kind: "timeout" as const }), () => ({ kind: "timeout" as const }));
  const winner = await Promise.race([invocation, timeout]);
  timer.abort();
  if (winner.kind === "timeout") cancellation.abort();
  return winner;
}

function resolveRetrySafety(executor: NodeExecutor, node: NodeDefinition): boolean {
  if (typeof executor.retrySafety !== "function") return false;
  try {
    return executor.retrySafety({ node: cloneNodeDefinition(node) }) === "safe";
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function cloneNodeDefinition<T>(node: T): T {
  return JSON.parse(JSON.stringify(node)) as T;
}
