import type { EdgeDefinition, JsonObject, NodeDefinition, RunState, Workflow } from "@aao/contracts";
import { compileWorkflow } from "@aao/workflow-dsl";
import type { CompiledWorkflowPlan } from "@aao/workflow-dsl";
import type { RuntimeClock } from "../src/clock.js";
import { finalOutputExecutor } from "../src/default-registry.js";
import { createNodeRegistry } from "../src/registry.js";
import type { ExecuteWorkflowRequest, NodeExecutor, NodeRegistry } from "../src/types.js";

/** Builds a schema-valid Workflow shell, matching the pattern @aao/workflow-dsl's own fixtures use. */
export function buildWorkflow(overrides: { entryNodeId: string; nodes: NodeDefinition[]; edges: EdgeDefinition[]; id?: string }): Workflow {
  return {
    schemaVersion: 1,
    id: overrides.id ?? "test.workflow",
    version: "1.0.0",
    name: "Test workflow",
    entryNodeId: overrides.entryNodeId,
    nodes: overrides.nodes,
    edges: overrides.edges,
  };
}

/** Compiles a Workflow and asserts success, for tests that only care about the resulting plan. */
export function compileOrThrow(workflow: Workflow): CompiledWorkflowPlan {
  const result = compileWorkflow(workflow);
  if (!result.ok) throw new Error(`fixture workflow failed to compile: ${JSON.stringify(result.diagnostics)}`);
  return result.plan;
}

export const minimalPlan: CompiledWorkflowPlan = compileOrThrow(
  buildWorkflow({
    entryNodeId: "intake",
    nodes: [
      { id: "intake", kind: "deterministic", config: {} },
      { id: "final", kind: "final_output", config: {} },
    ],
    edges: [{ sourceNodeId: "intake", targetNodeId: "final" }],
  }),
);

export function buildRunState(runId: string, values: JsonObject = {}): RunState {
  return { runId, revision: 0, values };
}

/**
 * A test/fixture-only deterministic executor: it reads a literal
 * `statePatch` straight out of `node.config` and proposes it unchanged. This
 * is intentionally generic (no business semantics like "qualify_lead") — see
 * docs/architecture/runtime-v1.md's "Deterministic Node Semantics" note.
 * Real deployments register their own executors; this one exists only to
 * exercise the Runtime in tests and the example script.
 */
export const literalPatchExecutor: NodeExecutor = {
  kind: "deterministic",
  async execute(context) {
    const config = context.node.config as { statePatch?: JsonObject };
    return config.statePatch !== undefined ? { ok: true, statePatch: config.statePatch } : { ok: true };
  },
};

export function createTestRegistry(...executors: NodeExecutor[]): NodeRegistry {
  const registry = createNodeRegistry();
  for (const executor of executors) registry.register(executor);
  return registry;
}

export function buildRequest(overrides: Partial<ExecuteWorkflowRequest> & { runId: string }): ExecuteWorkflowRequest {
  return {
    runId: overrides.runId,
    plan: overrides.plan ?? minimalPlan,
    initialState: overrides.initialState ?? buildRunState(overrides.runId),
    registry: overrides.registry ?? createTestRegistry(literalPatchExecutor, finalOutputExecutor),
    ...(overrides.options !== undefined ? { options: overrides.options } : {}),
  };
}

/**
 * A deterministic, test-only `RuntimeClock`: each call to `now()` returns
 * the next timestamp from a fixed, strictly increasing sequence (one second
 * apart, starting at `start`), then holds at the last value once exhausted.
 * Lets lifecycle tests assert exact timestamps and ordering without ever
 * touching the real wall clock.
 */
export function buildTestClock(start = "2026-01-01T00:00:00.000Z"): RuntimeClock & { callCount(): number } {
  const startMs = new Date(start).getTime();
  let calls = 0;
  return {
    now(): string {
      const timestamp = new Date(startMs + calls * 1000).toISOString();
      calls += 1;
      return timestamp;
    },
    callCount(): number {
      return calls;
    },
  };
}

/**
 * A deterministic, test-only `RuntimeSleeper`. Retry delays (no signal)
 * resolve immediately and are recorded. Attempt timeouts (with a signal)
 * are recorded and, by default, hold until the Runtime aborts them — i.e.
 * the attempt wins; `fireTimeout(index)` makes the index-th timeout (0-based)
 * expire immediately instead. No real time ever passes.
 */
export function buildTestSleeper(fireTimeout: (index: number) => boolean = () => false) {
  const delays: number[] = [];
  const timeouts: { ms: number; signal: AbortSignal }[] = [];
  return {
    delays,
    timeouts,
    sleep(ms: number, signal?: AbortSignal): Promise<void> {
      if (signal === undefined) {
        delays.push(ms);
        return Promise.resolve();
      }
      const index = timeouts.length;
      timeouts.push({ ms, signal });
      if (fireTimeout(index)) return Promise.resolve();
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  };
}

/** A manually settled promise, for attempts whose completion a test controls. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
