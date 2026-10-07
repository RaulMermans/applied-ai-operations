// Real compiled-package Sprint 13 acceptance path. Run after `pnpm build`.
import process from "node:process";
import { setImmediate } from "node:timers";
import { compileWorkflowSource } from "@aao/workflow-dsl";
import { createNodeRegistry, executeWorkflow, finalOutputExecutor } from "@aao/runtime";
import { createToolNodeExecutor, createToolRegistry } from "@aao/tool-runtime";

const compiled = compileWorkflowSource(`
schemaVersion: 1
id: smoke.reliability
version: "1.0.0"
name: Smoke reliability
entryNodeId: lookup
nodes:
  - id: lookup
    kind: tool
    config:
      toolRef: { id: local.lookup, version: "1.0.0" }
      inputStateKey: lookupInput
      resultStateKey: lookupResult
  - id: final
    kind: final_output
    config: {}
edges:
  - { sourceNodeId: lookup, targetNodeId: final }
`, "yaml");
if (!compiled.ok) throw new Error("Compilation failed");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function scenario(script, policy, sleeper) {
  let calls = 0;
  const signals = [];
  const tools = createToolRegistry();
  tools.register({
    spec: { schemaVersion: 1, id: "local.lookup", version: "1.0.0", name: "Lookup", inputSchema: { type: "object" }, outputSchema: { type: "object" }, permissionClasses: ["read_only"] },
    retrySafety: "safe",
    handler: { execute(context) { signals.push(context.signal); return script[Math.min(calls++, script.length - 1)](); } },
  });
  const registry = createNodeRegistry();
  registry.register(createToolNodeExecutor({ tools, resolveAuthorizationContext: () => ({ schemaVersion: 1, principal: { id: "user.alice", type: "user" }, grantedPermissionClasses: ["read_only"] }) }));
  registry.register(finalOutputExecutor);
  let tick = 0;
  const clock = { now: () => new Date(Date.UTC(2026, 9, 7, 12, 0, tick++)).toISOString() };
  const runId = "run.smoke.reliability";
  const result = await executeWorkflow({ runId, plan: compiled.plan, registry, initialState: { runId, revision: 0, values: { lookupInput: { query: "alpha" } } }, options: { clock, sleeper, reliability: { policiesByNodeId: { lookup: policy } } } });
  return { result, calls: () => calls, signals };
}

const recordingSleeper = () => ({ delays: [], sleep(ms, signal) { if (!signal) { this.delays.push(ms); return Promise.resolve(); } return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); } });

// 1. transient failure → bounded retry → success → complete.
const sleeper = recordingSleeper();
const retried = await scenario([() => ({ ok: false, code: "DEPENDENCY_TEMPORARILY_UNAVAILABLE", retryable: true }), () => ({ ok: true, output: { items: ["alpha-result"] } })], { maxAttempts: 3, retryDelayMs: 50 }, sleeper);
assert(retried.result.ok && retried.result.execution.run.status === "COMPLETED", "retry did not complete");
assert(retried.calls() === 2 && sleeper.delays.join() === "50", "unexpected attempt/delay count");
assert(retried.result.execution.state.revision === 1 && retried.result.execution.history[0].attemptCount === 2, "state committed more than once");

// 2. timeout race: attempt 1 hangs and times out, attempt 2 commits, the late result is ignored.
let releaseLate;
let timeoutIndex = 0;
const raceSleeper = { sleep: (_ms, signal) => (signal && timeoutIndex++ === 0 ? Promise.resolve() : new Promise((resolve) => (signal ? signal.addEventListener("abort", () => resolve(), { once: true }) : resolve()))) };
const race = await scenario([() => new Promise((resolve) => { releaseLate = resolve; }), () => ({ ok: true, output: { items: ["second"] } })], { maxAttempts: 2, attemptTimeoutMs: 1000 }, raceSleeper);
assert(race.result.ok && race.calls() === 2 && race.signals[0].aborted === true, "timeout retry failed");
const before = JSON.stringify(race.result);
releaseLate({ ok: true, output: { items: ["late"] } });
await new Promise((resolve) => setImmediate(resolve));
assert(JSON.stringify(race.result) === before && race.result.execution.state.values.lookupResult.output.items[0] === "second", "late result mutated state");

// 3. exhaustion: every attempt transient → NODE_RETRY_EXHAUSTED, state unchanged.
const exhausted = await scenario([() => ({ ok: false, code: "DEPENDENCY_TEMPORARILY_UNAVAILABLE", retryable: true })], { maxAttempts: 3 }, recordingSleeper());
assert(!exhausted.result.ok && exhausted.result.failure.code === "NODE_RETRY_EXHAUSTED" && exhausted.calls() === 3 && exhausted.result.execution.state.revision === 0, "exhaustion invariant failed");

process.stdout.write("SPRINT_13_RELIABILITY_RUNTIME_SMOKE_OK\n");
