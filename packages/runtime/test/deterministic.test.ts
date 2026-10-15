import { describe, expect, it } from "vitest";
import { createDeterministicNodeExecutor, type DeterministicExecutor } from "../src/deterministic.js";
import { finalOutputExecutor } from "../src/default-registry.js";
import { executeWorkflow } from "../src/engine.js";
import { createNodeRegistry } from "../src/registry.js";
import { buildRunState, buildWorkflow, compileOrThrow } from "./fixtures.js";

/**
 * ADR-025: public deterministic execution is trusted host code, referenced
 * by an exact `executorRef` in node config. It is not an adapter. It gets
 * minimum context, proposes a patch the Runtime validates, registers at
 * construction only, and never declares retry or crash replay safe.
 */
const plan = (config: object) =>
  compileOrThrow(
    buildWorkflow({
      entryNodeId: "normalize",
      nodes: [
        { id: "normalize", kind: "deterministic", config: config as never },
        { id: "final", kind: "final_output", config: {} },
      ],
      edges: [{ sourceNodeId: "normalize", targetNodeId: "final" }],
    }),
  );

const upper: DeterministicExecutor = {
  id: "text.upper",
  version: "1.0.0",
  async execute({ state }) {
    return { ok: true, statePatch: { normalized: String(state.values.raw).toUpperCase() } };
  },
};

function run(executors: DeterministicExecutor[], config: object = { executorRef: { id: "text.upper", version: "1.0.0" } }, values: Record<string, string> = { raw: "acme" }) {
  const registry = createNodeRegistry();
  registry.register(createDeterministicNodeExecutor(executors));
  registry.register(finalOutputExecutor);
  return executeWorkflow({ runId: "run-det", plan: plan(config), registry, initialState: buildRunState("run-det", values) });
}

describe("deterministic node executor", () => {
  it("runs the exact registered executor and applies its patch through the Runtime", async () => {
    const result = await run([upper]);
    expect(result.ok && result.execution.state.values).toEqual({ raw: "acme", normalized: "ACME" });
    expect(result.ok && result.execution.state.revision).toBe(1);
  });

  it("an unregistered or inexact executorRef fails preflight before anything runs (no latest, no name matching)", async () => {
    for (const config of [{ executorRef: { id: "text.upper", version: "2.0.0" } }, { executorRef: { id: "text.lower", version: "1.0.0" } }, {}, { executorRef: "text.upper" }, { executorRef: { id: "text.upper", version: "1.0.0" }, code: "return 1" }]) {
      const result = await run([upper], config);
      expect(result).toMatchObject({ ok: false, failure: { code: "RUNTIME_PREFLIGHT_FAILED" } });
    }
  });

  it("duplicate exact refs, invalid identity, or a missing execute function fail at construction", () => {
    expect(() => createDeterministicNodeExecutor([upper, { ...upper }])).toThrow(/already registered/);
    expect(() => createDeterministicNodeExecutor([{ ...upper, id: "bad id" }])).toThrow(/invalid id or version/);
    expect(() => createDeterministicNodeExecutor([{ id: "x", version: "1.0.0" } as never])).toThrow(/no execute function/);
    expect(() => createDeterministicNodeExecutor([upper, { ...upper, version: "2.0.0" }])).not.toThrow();
  });

  it("captures execute at construction: mutating the caller's executor afterwards changes nothing", async () => {
    const source: DeterministicExecutor = { ...upper };
    const registry = createNodeRegistry();
    registry.register(createDeterministicNodeExecutor([source]));
    registry.register(finalOutputExecutor);
    (source as { execute: DeterministicExecutor["execute"] }).execute = async () => ({ ok: true, statePatch: { normalized: "HIJACKED" } });
    const result = await executeWorkflow({ runId: "run-det", plan: plan({ executorRef: { id: "text.upper", version: "1.0.0" } }), registry, initialState: buildRunState("run-det", { raw: "acme" }) });
    expect(result.ok && result.execution.state.values.normalized).toBe("ACME");
  });

  it("receives the minimum context: identity, a frozen detached state copy, and the attempt signal. It cannot mutate authoritative state", async () => {
    let seen: Record<string, unknown> | undefined;
    const probe: DeterministicExecutor = {
      id: "probe",
      version: "1.0.0",
      async execute(context) {
        seen = { keys: Object.keys(context).sort(), frozen: Object.isFrozen(context.state.values), signal: context.signal instanceof AbortSignal };
        try { (context.state.values as Record<string, unknown>).raw = "tampered"; } catch { /* frozen */ }
        return { ok: true };
      },
    };
    const result = await run([probe], { executorRef: { id: "probe", version: "1.0.0" } });
    expect(seen).toEqual({ keys: ["nodeId", "runId", "signal", "state"], frozen: true, signal: true });
    expect(result.ok && result.execution.state.values.raw).toBe("acme");
  });

  it("an expected failure is the canonical NODE_EXECUTION_FAILED with namespace deterministic; a malformed code is bounded", async () => {
    const failing: DeterministicExecutor = { id: "fails", version: "1.0.0", execute: async () => ({ ok: false, code: "INPUT_UNUSABLE" }) };
    expect(await run([failing], { executorRef: { id: "fails", version: "1.0.0" } })).toMatchObject({ ok: false, failure: { code: "NODE_EXECUTION_FAILED", executorFailure: { namespace: "deterministic", code: "INPUT_UNUSABLE" } } });
    const leaky: DeterministicExecutor = { id: "leaky", version: "1.0.0", execute: async () => ({ ok: false, code: "secret sk-live-123 at /home/x" }) };
    const leaked = await run([leaky], { executorRef: { id: "leaky", version: "1.0.0" } });
    expect(leaked).toMatchObject({ ok: false, failure: { executorFailure: { namespace: "deterministic", code: "DETERMINISTIC_EXECUTOR_FAILED" } } });
    expect(JSON.stringify(leaked)).not.toContain("sk-live-123");
  });

  it("a thrown error or a non-JSON patch stays a canonical Runtime failure, never the thrown value", async () => {
    const throwing: DeterministicExecutor = { id: "throws", version: "1.0.0", execute: async () => { throw new Error("boom sk-live-999"); } };
    const thrown = await run([throwing], { executorRef: { id: "throws", version: "1.0.0" } });
    expect(thrown).toMatchObject({ ok: false, failure: { code: "NODE_EXECUTION_FAILED" } });
    expect(JSON.stringify(thrown)).not.toContain("sk-live-999");
    const unsafe: DeterministicExecutor = { id: "unsafe", version: "1.0.0", execute: async () => ({ ok: true, statePatch: { when: new Date(0) as never } }) };
    expect((await run([unsafe], { executorRef: { id: "unsafe", version: "1.0.0" } })).ok).toBe(false);
  });

  it("never declares retry or crash-replay safety: host code is opaque", () => {
    const executor = createDeterministicNodeExecutor([upper]);
    expect(executor.retrySafety).toBeUndefined();
    expect(executor.recoverySafety).toBeUndefined();
  });
});
