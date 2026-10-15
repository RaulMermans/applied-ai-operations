import { describe, expect, it } from "vitest";
import type { ModelAdapter, ModelAdapterContext } from "@aao/model-runtime";
import { executeAgent } from "../src/controller.js";
import { TEXT_AND_STRUCTURED, buildAgent, buildRequest, buildWorld, decision } from "./fixtures.js";

/**
 * ADR-025: the bounded Agent Runtime propagates the caller's cancellation
 * lineage into every model invocation. Once cancellation is observable, no
 * new iteration starts, and there is no cleanup loop. Bounds are unchanged.
 */
describe("Agent cancellation", () => {
  it("every iteration's model call receives the same caller signal", async () => {
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const responses = [decision("CONTINUE", "draft 1"), decision("CONTINUE", "draft 2"), decision("COMPLETE", "final")];
    const adapter: ModelAdapter = { invoke: async (_request, context: ModelAdapterContext) => { seen.push(context.signal); return responses.shift()!; } };
    const world = buildWorld([], { agents: [buildAgent({ limits: { maxIterations: 4 } })], bindings: [{ id: "local.primary", priority: 10, capabilities: TEXT_AND_STRUCTURED, adapter }] });
    const outcome = await executeAgent({ ...world, request: buildRequest(), signal: controller.signal });
    expect(outcome.ok && outcome.result.iterationsUsed).toBe(3);
    expect(seen).toHaveLength(3);
    expect(seen.every((signal) => signal === controller.signal)).toBe(true);
  });

  it("an abort during iteration 1 starts no iteration 2: AGENT_CANCELLED with the evidence so far, one model call", async () => {
    const controller = new AbortController();
    let calls = 0;
    const adapter: ModelAdapter = {
      invoke: async () => {
        calls += 1;
        controller.abort();
        return decision("CONTINUE", "draft 1");
      },
    };
    const world = buildWorld([], { agents: [buildAgent({ limits: { maxIterations: 4 } })], bindings: [{ id: "local.primary", priority: 10, capabilities: TEXT_AND_STRUCTURED, adapter }] });
    const outcome = await executeAgent({ ...world, request: buildRequest(), signal: controller.signal });
    expect(calls).toBe(1);
    expect(outcome).toMatchObject({ ok: false, failure: { code: "AGENT_CANCELLED", iteration: 2 } });
    expect(!outcome.ok && outcome.failure.history).toHaveLength(1);
  });

  it("an already-aborted signal makes no model call at all", async () => {
    const controller = new AbortController();
    controller.abort();
    const world = buildWorld([decision("COMPLETE", "never")]);
    const outcome = await executeAgent({ ...world, request: buildRequest(), signal: controller.signal });
    expect(outcome).toMatchObject({ ok: false, failure: { code: "AGENT_CANCELLED", iteration: 1 } });
    expect(world.primary.calls).toHaveLength(0);
  });

  it("without a signal, bounded semantics are exactly unchanged (max iterations still fail closed)", async () => {
    const world = buildWorld([decision("CONTINUE", "a"), decision("CONTINUE", "b")], { agents: [buildAgent({ limits: { maxIterations: 2 } })] });
    expect(await executeAgent({ ...world, request: buildRequest() })).toMatchObject({ ok: false, failure: { code: "MAX_AGENT_ITERATIONS_EXCEEDED" } });
    expect(world.primary.calls).toHaveLength(2);
  });
});
