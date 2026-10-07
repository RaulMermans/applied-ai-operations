import { describe, expect, it } from "vitest";
import type { FailureCategory, JsonObject } from "@aao/contracts";
import { executeWorkflow } from "../src/engine.js";
import { finalOutputExecutor } from "../src/default-registry.js";
import { validateSnapshotAgainstPlan } from "../src/execution-snapshot.js";
import { DEFAULT_RELIABILITY_POLICY, createSystemSleeper } from "../src/reliability.js";
import type { NodeExecutionContext, NodeExecutionResult, NodeExecutor, RuntimeOptions } from "../src/types.js";
import { buildRunState, buildTestClock, buildTestSleeper, buildWorkflow, compileOrThrow, createTestRegistry, deferred, literalPatchExecutor } from "./fixtures.js";

/**
 * Sprint 13 Runtime Reliability (ADR-018): bounded, deterministic,
 * process-local retries. Every test drives the canonical `executeWorkflow`
 * loop with an injected clock and sleeper — no real time passes.
 */
const plan = compileOrThrow(
  buildWorkflow({
    entryNodeId: "intake",
    nodes: [
      { id: "intake", kind: "deterministic", config: { statePatch: { seen: true } } },
      { id: "work", kind: "evaluator", config: {} },
      { id: "final", kind: "final_output", config: {} },
    ],
    edges: [
      { sourceNodeId: "intake", targetNodeId: "work" },
      { sourceNodeId: "work", targetNodeId: "final" },
    ],
  }),
);

const transient = (code = "DEPENDENCY_TEMPORARILY_UNAVAILABLE", category: FailureCategory = "TRANSIENT_DEPENDENCY"): NodeExecutionResult => ({ ok: false, failure: { namespace: "dependency", code, category } });
const success = (patch: JsonObject = { result: "ok" }): NodeExecutionResult => ({ ok: true, statePatch: patch, output: { done: true } });

/** A scripted `evaluator` executor: each attempt answers from `script` (the last entry repeats). */
function scripted(script: Array<NodeExecutionResult | "throw" | (() => Promise<NodeExecutionResult>)>, retrySafety?: NodeExecutor["retrySafety"]) {
  const contexts: NodeExecutionContext[] = [];
  const executor: NodeExecutor = {
    kind: "evaluator",
    ...(retrySafety ? { retrySafety } : {}),
    async execute(context) {
      contexts.push(context);
      const step = script[Math.min(contexts.length - 1, script.length - 1)]!;
      if (step === "throw") throw new Error("sk-live-SECRET-transient upstream 503 at https://internal.example.com retry later");
      return typeof step === "function" ? step() : step;
    },
  };
  return { executor, contexts };
}
const safe = () => "safe" as const;

function run(executor: NodeExecutor, options: Omit<RuntimeOptions, "clock"> = {}, runId = "run.reliability") {
  const clock = buildTestClock();
  const sleeper = options.sleeper ?? buildTestSleeper();
  const registry = createTestRegistry(literalPatchExecutor, executor, finalOutputExecutor);
  const initialState = buildRunState(runId, { input: "x" });
  return { clock, sleeper, initialState, result: executeWorkflow({ runId, plan, initialState, registry, options: { clock, sleeper, ...options } }) };
}
const policy = (maxAttempts: number, extra: { attemptTimeoutMs?: number; retryDelayMs?: number } = {}): RuntimeOptions["reliability"] => ({ policiesByNodeId: { work: { maxAttempts, ...extra } } });

describe("reliability policy — trusted, bounded configuration", () => {
  it("defaults to exactly one attempt even for a retry-safe executor reporting a transient failure", async () => {
    expect(DEFAULT_RELIABILITY_POLICY).toEqual({ maxAttempts: 1 });
    const { executor, contexts } = scripted([transient(), success()], safe);
    const result = await run(executor).result;
    expect(contexts).toHaveLength(1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatchObject({ code: "NODE_EXECUTION_FAILED", category: "TRANSIENT_DEPENDENCY", retryable: true, attempt: 1, maxAttempts: 1 });
    expect(result.failure).not.toHaveProperty("causeCode");
  });

  it.each<[string, unknown]>([
    ["maxAttempts 0", { policiesByNodeId: { work: { maxAttempts: 0 } } }],
    ["maxAttempts above the hard cap", { policiesByNodeId: { work: { maxAttempts: 4 } } }],
    ["fractional maxAttempts", { policiesByNodeId: { work: { maxAttempts: 2.5 } } }],
    ["zero timeout", { policiesByNodeId: { work: { maxAttempts: 2, attemptTimeoutMs: 0 } } }],
    ["negative timeout", { policiesByNodeId: { work: { maxAttempts: 2, attemptTimeoutMs: -5 } } }],
    ["unbounded timeout", { policiesByNodeId: { work: { maxAttempts: 2, attemptTimeoutMs: 600_001 } } }],
    ["negative delay", { policiesByNodeId: { work: { maxAttempts: 2, retryDelayMs: -1 } } }],
    ["unbounded delay", { policiesByNodeId: { work: { maxAttempts: 2, retryDelayMs: 60_001 } } }],
    ["infinite delay", { policiesByNodeId: { work: { maxAttempts: 2, retryDelayMs: Number.POSITIVE_INFINITY } } }],
    ["unknown policy field", { policiesByNodeId: { work: { maxAttempts: 2, retrySafety: "safe" } } }],
    ["unknown node", { policiesByNodeId: { ghost: { maxAttempts: 2 } } }],
    ["unknown reliability field", { policiesByNodeId: {}, defaultMaxAttempts: 3 }],
    ["executable callback", { policiesByNodeId: { work: { maxAttempts: 2, shouldRetry: () => true } } }],
    ["array", []],
  ])("rejects %s before any node executes (INVALID_RUNTIME_INPUT)", async (_label, reliability) => {
    const { executor, contexts } = scripted([success()], safe);
    const result = await run(executor, { reliability: reliability as never }).result;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("INVALID_RUNTIME_INPUT");
    expect(result.execution).toBeUndefined();
    expect(contexts).toHaveLength(0);
  });

  it("rejects a sleeper that is not a sleeper", async () => {
    const { executor } = scripted([success()]);
    const result = await run(executor, { sleeper: {} as never }).result;
    expect(!result.ok && result.failure.code).toBe("INVALID_RUNTIME_INPUT");
  });

  it("accepts the hard-cap policy and never exceeds it", async () => {
    const { executor, contexts } = scripted([transient()], safe);
    const result = await run(executor, { reliability: policy(3, { attemptTimeoutMs: 600_000, retryDelayMs: 60_000 }) }).result;
    expect(contexts.map((context) => context.attempt)).toEqual([1, 2, 3]);
    expect(!result.ok && result.failure.code).toBe("NODE_RETRY_EXHAUSTED");
  });

  it("workflow config, workflow state, and executor output cannot raise the attempt budget", async () => {
    const configured = compileOrThrow(
      buildWorkflow({
        entryNodeId: "work",
        nodes: [
          { id: "work", kind: "evaluator", config: { reliability: { maxAttempts: 3 }, maxAttempts: 3, retrySafety: "safe" } },
          { id: "final", kind: "final_output", config: {} },
        ],
        edges: [{ sourceNodeId: "work", targetNodeId: "final" }],
      }),
    );
    const { executor, contexts } = scripted([transient(), success()]);
    const registry = createTestRegistry(executor, finalOutputExecutor);
    const initialState = buildRunState("run.untrusted", { reliability: { policiesByNodeId: { work: { maxAttempts: 3 } } }, retrySafe: true });
    const result = await executeWorkflow({ runId: "run.untrusted", plan: configured, initialState, registry, options: { clock: buildTestClock(), sleeper: buildTestSleeper() } });
    expect(contexts).toHaveLength(1);
    expect(!result.ok && result.failure.maxAttempts).toBe(1);

    // An executor cannot smuggle reliability fields through its failure: the result is malformed and non-retryable.
    const smuggler = scripted([{ ok: false, failure: { namespace: "x", code: "TRANSIENT", category: "TRANSIENT_DEPENDENCY", maxAttempts: 9, retryable: true } } as never], safe);
    const smuggled = await run(smuggler.executor, { reliability: policy(3) }).result;
    expect(smuggler.contexts).toHaveLength(1);
    expect(!smuggled.ok && smuggled.failure).toMatchObject({ code: "INVALID_NODE_RESULT", category: "VALIDATION", retryable: false });
    // An unknown category value is equally malformed.
    const invented = scripted([{ ok: false, failure: { namespace: "x", code: "X", category: "PLEASE_RETRY" } } as never], safe);
    expect(await run(invented.executor, { reliability: policy(3) }).result).toMatchObject({ ok: false, failure: { code: "INVALID_NODE_RESULT" } });
    expect(invented.contexts).toHaveLength(1);
  });
});

describe("failure classification — structured, fail closed", () => {
  it.each<FailureCategory>(["VALIDATION", "AUTHORIZATION", "POLICY", "APPROVAL", "EXECUTION", "INTERNAL"])("%s is never retried, even when safe with budget", async (category) => {
    const { executor, contexts } = scripted([transient("SOME_CODE", category), success()], safe);
    const result = await run(executor, { reliability: policy(3) }).result;
    expect(contexts).toHaveLength(1);
    expect(!result.ok && result.failure).toMatchObject({ code: "NODE_EXECUTION_FAILED", category, retryable: false, attempt: 1, maxAttempts: 3 });
  });

  it.each<FailureCategory>(["TRANSIENT_DEPENDENCY", "RATE_LIMIT"])("%s is retried when safe with budget", async (category) => {
    const { executor, contexts } = scripted([transient("BUSY", category), success()], safe);
    const result = await run(executor, { reliability: policy(2) }).result;
    expect(contexts).toHaveLength(2);
    expect(result.ok).toBe(true);
  });

  it("an unclassified executor failure is EXECUTION and non-retryable, whatever its code says", async () => {
    const { executor, contexts } = scripted([{ ok: false, failure: { namespace: "dependency", code: "TRANSIENT_TIMEOUT_RETRYABLE" } }, success()], safe);
    const result = await run(executor, { reliability: policy(3) }).result;
    expect(contexts).toHaveLength(1);
    expect(!result.ok && result.failure).toMatchObject({ category: "EXECUTION", retryable: false });
  });

  it("a thrown exception is INTERNAL and never retried — its message is never read, and nothing leaks", async () => {
    const { executor, contexts } = scripted(["throw", success()], safe);
    const result = await run(executor, { reliability: policy(3) }).result;
    expect(contexts).toHaveLength(1);
    expect(!result.ok && result.failure).toMatchObject({ code: "NODE_EXECUTION_FAILED", category: "INTERNAL", retryable: false });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|example\.com|503|retry later/);
  });

  it("invalid results and invalid state patches are VALIDATION and never retried", async () => {
    for (const bad of [{ ok: true, statePatch: [1] }, { ok: true, extra: 1 }, { ok: true, wait: { kind: "approval", referenceId: "a.b", requestFingerprint: "a".repeat(64) } }]) {
      const { executor, contexts } = scripted([bad as never, success()], safe);
      const result = await run(executor, { reliability: policy(3) }).result;
      expect(contexts).toHaveLength(1);
      expect(!result.ok && result.failure).toMatchObject({ category: "VALIDATION", retryable: false, attempt: 1 });
    }
  });
});

describe("retry safety — explicit, trusted, default unsafe", () => {
  it.each<[string, NodeExecutor["retrySafety"] | undefined]>([
    ["no declaration", undefined],
    ["declared unsafe", () => "unsafe"],
    ["declaration throws", () => { throw new Error("boom"); }],
    ["declaration returns garbage", () => "yes" as never],
  ])("retryable failure + %s → exactly one attempt", async (_label, retrySafety) => {
    const { executor, contexts } = scripted([transient(), success()], retrySafety);
    const result = await run(executor, { reliability: policy(3) }).result;
    expect(contexts).toHaveLength(1);
    expect(!result.ok && result.failure).toMatchObject({ code: "NODE_EXECUTION_FAILED", category: "TRANSIENT_DEPENDENCY", retryable: true, attempt: 1, maxAttempts: 3 });
  });

  it("retry safety is resolved from a clone of the static node only", async () => {
    const seen: unknown[] = [];
    const { executor } = scripted([success()], (context) => {
      seen.push(context);
      (context.node.config as Record<string, unknown>).mutated = true;
      return "safe";
    });
    const result = await run(executor, { reliability: policy(2) }).result;
    expect(seen).toEqual([{ node: { id: "work", kind: "evaluator", config: { mutated: true } } }]);
    expect(result.ok && result.execution.history[1]).toMatchObject({ nodeId: "work", attemptCount: 1 });
    expect(plan.nodesById.work?.config).toEqual({});
  });
});

describe("retry success and exhaustion — commit on success only", () => {
  it("attempt 1 transient → attempt 2 success: patch applied once, revision +1, Node SUCCEEDED, Run COMPLETED", async () => {
    const { executor, contexts } = scripted([transient(), success({ result: "second" })], safe);
    const { result: pending, clock } = run(executor, { reliability: policy(3) });
    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(contexts.map((context) => context.attempt)).toEqual([1, 2]);
    expect(result.execution.run.status).toBe("COMPLETED");
    expect(result.execution.nodeStatusesById).toEqual({ intake: "SUCCEEDED", work: "SUCCEEDED", final: "SUCCEEDED" });
    expect(result.execution.state).toEqual({ runId: "run.reliability", revision: 2, values: { input: "x", seen: true, result: "second" } });
    expect(result.execution.history[1]).toEqual({
      nodeId: "work",
      kind: "evaluator",
      step: 2,
      status: "SUCCEEDED",
      output: { done: true },
      stateRevisionBefore: 1,
      stateRevisionAfter: 2,
      attemptCount: 2,
      attemptFailures: [{ attempt: 1, category: "TRANSIENT_DEPENDENCY", causeCode: "DEPENDENCY_TEMPORARILY_UNAVAILABLE" }],
    });
    expect(result.execution.history.map((record) => record.attemptCount)).toEqual([1, 2, 1]);
    expect(result.output).toEqual({ input: "x", seen: true, result: "second" });
    expect(validateSnapshotAgainstPlan(result.latestSnapshot, plan)).toBeUndefined();
    expect(result.latestSnapshot.schemaVersion).toBe(2);
    expect(clock.callCount()).toBeGreaterThan(0);
  });

  it("every attempt receives the same authoritative input; an attempt's own mutations never reach the next", async () => {
    const seen: unknown[] = [];
    const executor: NodeExecutor = {
      kind: "evaluator",
      retrySafety: safe,
      async execute(context) {
        seen.push(JSON.parse(JSON.stringify(context.state)));
        context.state.values.poisoned = context.attempt;
        context.state.revision = 99;
        return context.attempt < 3 ? transient() : success();
      },
    };
    const result = await run(executor, { reliability: policy(3) }).result;
    expect(seen).toEqual([0, 1, 2].map(() => ({ runId: "run.reliability", revision: 1, values: { input: "x", seen: true } })));
    expect(result.ok && result.execution.state.values).toEqual({ input: "x", seen: true, result: "ok" });
  });

  it("retries happen inside one RUNNING lifecycle: no lifecycle transition, timestamp, or snapshot between attempts", async () => {
    const clock = buildTestClock();
    const callsAtAttempt: number[] = [];
    const executor: NodeExecutor = {
      kind: "evaluator",
      retrySafety: safe,
      async execute(context) {
        callsAtAttempt.push(clock.callCount());
        return context.attempt < 3 ? transient() : success();
      },
    };
    const registry = createTestRegistry(literalPatchExecutor, executor, finalOutputExecutor);
    const result = await executeWorkflow({ runId: "run.lifecycle", plan, initialState: buildRunState("run.lifecycle"), registry, options: { clock, sleeper: buildTestSleeper(), reliability: policy(3, { retryDelayMs: 25 }) } });
    expect(result.ok && result.execution.run.status).toBe("COMPLETED");
    // The clock (every Run transition and snapshot) is untouched while attempts run.
    expect(new Set(callsAtAttempt).size).toBe(1);
  });

  it("exhaustion: three transient attempts → NODE_RETRY_EXHAUSTED, revision unchanged, bounded delays, Run FAILED", async () => {
    const { executor, contexts } = scripted([transient()], safe);
    const sleeper = buildTestSleeper();
    const result = await run(executor, { reliability: policy(3, { retryDelayMs: 50 }), sleeper }).result;
    expect(contexts).toHaveLength(3);
    expect(sleeper.delays).toEqual([50, 50]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({
      code: "NODE_RETRY_EXHAUSTED",
      message: 'Node "work" (kind "evaluator") failed all 3 attempts.',
      nodeId: "work",
      step: 2,
      executorFailure: { namespace: "dependency", code: "DEPENDENCY_TEMPORARILY_UNAVAILABLE", category: "TRANSIENT_DEPENDENCY" },
      category: "TRANSIENT_DEPENDENCY",
      retryable: true,
      attempt: 3,
      maxAttempts: 3,
      causeCode: "DEPENDENCY_TEMPORARILY_UNAVAILABLE",
    });
    expect(result.execution?.run.status).toBe("FAILED");
    expect(result.execution?.nodeStatusesById).toEqual({ intake: "SUCCEEDED", work: "FAILED", final: "PENDING" });
    expect(result.execution?.state.revision).toBe(1);
    expect(result.execution?.history[1]).toMatchObject({ status: "FAILED", stateRevisionBefore: 1, stateRevisionAfter: 1, attemptCount: 3 });
    expect(result.execution?.history[1]?.attemptFailures).toHaveLength(3);
    expect(validateSnapshotAgainstPlan(result.latestSnapshot, plan)).toBeUndefined();
  });

  it("a zero retry delay never calls the sleeper", async () => {
    const { executor } = scripted([transient(), success()], safe);
    const sleeper = buildTestSleeper();
    await run(executor, { reliability: policy(2), sleeper }).result;
    expect(sleeper.delays).toEqual([]);
    expect(sleeper.timeouts).toEqual([]);
  });

  it("attempt budgets are per Node execution and per Run", async () => {
    const twoNode = compileOrThrow(
      buildWorkflow({
        entryNodeId: "a",
        nodes: [
          { id: "a", kind: "evaluator", config: {} },
          { id: "b", kind: "evaluator", config: {} },
          { id: "final", kind: "final_output", config: {} },
        ],
        edges: [
          { sourceNodeId: "a", targetNodeId: "b" },
          { sourceNodeId: "b", targetNodeId: "final" },
        ],
      }),
    );
    const attempts: string[] = [];
    const executor: NodeExecutor = {
      kind: "evaluator",
      retrySafety: safe,
      async execute(context) {
        attempts.push(`${context.runId}:${context.node.id}:${context.attempt}`);
        return context.attempt === 1 ? transient() : success({ [context.node.id]: context.attempt });
      },
    };
    const registry = createTestRegistry(executor, finalOutputExecutor);
    const reliability = { policiesByNodeId: { a: { maxAttempts: 2 }, b: { maxAttempts: 2 } } };
    for (const runId of ["run.one", "run.two"]) {
      const result = await executeWorkflow({ runId, plan: twoNode, initialState: buildRunState(runId), registry, options: { clock: buildTestClock(), sleeper: buildTestSleeper(), reliability } });
      expect(result.ok && result.execution.history.map((record) => record.attemptCount)).toEqual([2, 2, 1]);
    }
    expect(attempts).toEqual(["run.one:a:1", "run.one:a:2", "run.one:b:1", "run.one:b:2", "run.two:a:1", "run.two:a:2", "run.two:b:1", "run.two:b:2"]);
  });

  it("is deterministic: identical inputs and failure sequences give identical results", async () => {
    const outcome = async () => {
      const { executor } = scripted([transient(), transient("SLOW", "RATE_LIMIT"), success()], safe);
      return run(executor, { reliability: policy(3, { retryDelayMs: 10 }) }).result;
    };
    const [first, second] = [await outcome(), await outcome()];
    expect(JSON.parse(JSON.stringify(first))).toEqual(JSON.parse(JSON.stringify(second)));
    expect(first.ok && first.execution.history[1]?.attemptFailures).toEqual([
      { attempt: 1, category: "TRANSIENT_DEPENDENCY", causeCode: "DEPENDENCY_TEMPORARILY_UNAVAILABLE" },
      { attempt: 2, category: "RATE_LIMIT", causeCode: "SLOW" },
    ]);
  });
});

describe("timeouts — bounded attempts, cooperative cancellation, late results ignored", () => {
  it("timeout race: attempt 1 times out, attempt 2 commits, attempt 1's late success is ignored", async () => {
    const late = deferred<NodeExecutionResult>();
    const { executor, contexts } = scripted([() => late.promise, success({ winner: "attempt-2" })], safe);
    const sleeper = buildTestSleeper((index) => index === 0);
    const result = await run(executor, { reliability: policy(3, { attemptTimeoutMs: 1_000 }), sleeper }).result;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const before = JSON.parse(JSON.stringify(result));
    expect(contexts).toHaveLength(2);
    expect(contexts[0]!.signal.aborted).toBe(true);
    expect(contexts[1]!.signal.aborted).toBe(false);
    // Each timeout timer is released once its race is decided.
    expect(sleeper.timeouts.map((timeout) => [timeout.ms, timeout.signal.aborted])).toEqual([[1_000, true], [1_000, true]]);

    late.resolve(success({ winner: "attempt-1-late", poisoned: true }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(JSON.parse(JSON.stringify(result))).toEqual(before);
    expect(result.execution.run.status).toBe("COMPLETED");
    expect(result.execution.nodeStatusesById.work).toBe("SUCCEEDED");
    expect(result.execution.state).toEqual({ runId: "run.reliability", revision: 2, values: { input: "x", seen: true, winner: "attempt-2" } });
    expect(result.output).toEqual({ input: "x", seen: true, winner: "attempt-2" });
    expect(result.execution.history.filter((record) => record.nodeId === "work")).toEqual([
      expect.objectContaining({ status: "SUCCEEDED", stateRevisionBefore: 1, stateRevisionAfter: 2, attemptCount: 2, attemptFailures: [{ attempt: 1, category: "TIMEOUT", causeCode: "NODE_ATTEMPT_TIMEOUT" }] }),
    ]);
    expect(contexts).toHaveLength(2);
  });

  it("a timed-out attempt that later throws or returns garbage is equally ignored", async () => {
    for (const settle of ["reject", "garbage"] as const) {
      const late = deferred<NodeExecutionResult>();
      const { executor } = scripted([() => late.promise, success()], safe);
      const result = await run(executor, { reliability: policy(2, { attemptTimeoutMs: 5 }), sleeper: buildTestSleeper((index) => index === 0) }).result;
      if (settle === "reject") late.reject(new Error("SECRET late failure"));
      else late.resolve({ ok: true, statePatch: { poisoned: true } } as never);
      await new Promise((resolve) => setImmediate(resolve));
      expect(result.ok && result.execution.state.values).toEqual({ input: "x", seen: true, result: "ok" });
    }
  });

  it("timeout exhaustion: every attempt times out → NODE_RETRY_EXHAUSTED, state unchanged, all attempts aborted", async () => {
    const hanging = deferred<NodeExecutionResult>();
    const { executor, contexts } = scripted([() => hanging.promise], safe);
    const result = await run(executor, { reliability: policy(3, { attemptTimeoutMs: 250 }), sleeper: buildTestSleeper(() => true) }).result;
    expect(contexts).toHaveLength(3);
    expect(contexts.every((context) => context.signal.aborted)).toBe(true);
    expect(!result.ok && result.failure).toEqual({
      code: "NODE_RETRY_EXHAUSTED",
      message: 'Node "work" (kind "evaluator") failed all 3 attempts.',
      nodeId: "work",
      step: 2,
      category: "TIMEOUT",
      retryable: true,
      attempt: 3,
      maxAttempts: 3,
      causeCode: "NODE_ATTEMPT_TIMEOUT",
    });
    expect(!result.ok && result.execution?.state.revision).toBe(1);
    expect(!result.ok && result.execution?.nodeStatusesById.work).toBe("FAILED");
    hanging.resolve(success({ poisoned: true }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(!result.ok && result.execution?.state.values).toEqual({ input: "x", seen: true });
  });

  it("a single-attempt or unsafe timeout fails once with NODE_ATTEMPT_TIMEOUT", async () => {
    for (const [maxAttempts, retrySafety] of [[1, safe], [3, undefined]] as const) {
      const hanging = deferred<NodeExecutionResult>();
      const { executor, contexts } = scripted([() => hanging.promise], retrySafety);
      const result = await run(executor, { reliability: policy(maxAttempts, { attemptTimeoutMs: 10 }), sleeper: buildTestSleeper(() => true) }).result;
      expect(contexts).toHaveLength(1);
      expect(!result.ok && result.failure).toMatchObject({ code: "NODE_ATTEMPT_TIMEOUT", category: "TIMEOUT", retryable: true, attempt: 1, maxAttempts });
    }
  });

  it("a failing sleeper fails closed as a timeout, never as success", async () => {
    const hanging = deferred<NodeExecutionResult>();
    const { executor } = scripted([() => hanging.promise]);
    const result = await run(executor, { reliability: policy(1, { attemptTimeoutMs: 10 }), sleeper: { sleep: () => Promise.reject(new Error("timer")) } }).result;
    expect(!result.ok && result.failure.code).toBe("NODE_ATTEMPT_TIMEOUT");
  });

  it("the system sleeper waits on the platform timer and releases it when aborted", async () => {
    const sleeper = createSystemSleeper();
    await sleeper.sleep(1);
    const controller = new AbortController();
    const pending = sleeper.sleep(60_000, controller.signal);
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
    const aborted = new AbortController();
    aborted.abort();
    await expect(sleeper.sleep(60_000, aborted.signal)).resolves.toBeUndefined();
  });
});

describe("approval waitpoints are not retried", () => {
  const approvalPlan = compileOrThrow(
    buildWorkflow({
      entryNodeId: "approval",
      nodes: [
        { id: "approval", kind: "approval", config: {} },
        { id: "final", kind: "final_output", config: {} },
      ],
      edges: [{ sourceNodeId: "approval", targetNodeId: "final" }],
    }),
  );

  it("a multi-attempt policy on an Approval Node is rejected as invalid trusted configuration", async () => {
    let calls = 0;
    const registry = createTestRegistry({ kind: "approval", retrySafety: safe, async execute() { calls++; return { ok: true, wait: { kind: "approval", referenceId: "approval.one", requestFingerprint: "a".repeat(64) } }; } }, finalOutputExecutor);
    const rejected = await executeWorkflow({ runId: "run.approval", plan: approvalPlan, initialState: buildRunState("run.approval"), registry, options: { reliability: { policiesByNodeId: { approval: { maxAttempts: 2 } } } } });
    expect(!rejected.ok && rejected.failure.code).toBe("INVALID_RUNTIME_INPUT");
    expect(calls).toBe(0);
    const waiting = await executeWorkflow({ runId: "run.approval", plan: approvalPlan, initialState: buildRunState("run.approval"), registry, options: { clock: buildTestClock(), reliability: { policiesByNodeId: { approval: { maxAttempts: 1, attemptTimeoutMs: 100 } } } } });
    expect(waiting.ok && waiting.execution.run.status).toBe("WAITING_FOR_APPROVAL");
    expect(calls).toBe(1);
  });
});
