import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { AdapterContractError, type AdapterManifest } from "@aao/adapters";
import { compileWorkflowSource } from "@aao/workflow-dsl";
import { createNodeRegistry, executeWorkflow, finalOutputExecutor } from "@aao/runtime";
import { defineModelAdapter } from "../src/adapter-definition.js";
import { VERCEL_AI_SDK_ADAPTER_MANIFEST, createVercelAiModelAdapter, defineVercelAiModelAdapter } from "../src/adapters/vercel-ai.js";
import { executeModelRequest } from "../src/executor.js";
import { createModelNodeExecutor } from "../src/model-node.js";
import type { ModelAdapter, ModelAdapterContext } from "../src/types.js";
import { TEXT_ONLY, buildRegistries, buildTextRequest, succeeded } from "./fixtures.js";

/**
 * ADR-025: `ModelAdapter` is the single public `model` adapter port, and
 * every invocation carries the caller's cancellation lineage as `signal`.
 */
const manifest = (overrides: Partial<AdapterManifest> = {}) => ({
  id: "test.native",
  version: "1.0.0",
  kind: "model" as const,
  capabilities: [
    { capability: "model.text_generation" as const, support: "supported" as const },
    { capability: "model.structured_output" as const, support: "supported" as const },
    { capability: "model.usage" as const, support: "unsupported" as const },
    { capability: "model.cancellation" as const, support: "supported" as const },
    { capability: "model.tool_call_response" as const, support: "unsupported" as const },
  ],
  ...overrides,
});

describe("defineModelAdapter: one canonical port plus a JSON-safe manifest", () => {
  it("validates and snapshots the manifest, captures invoke, and keeps both detached from the caller", async () => {
    const input = manifest();
    const source: ModelAdapter = { invoke: async () => succeeded("first") };
    const definition = defineModelAdapter({ manifest: input, adapter: source });
    input.capabilities[0]!.support = "unsupported";
    source.invoke = async () => succeeded("hijacked");
    expect(definition.manifest.capabilities[0]).toEqual({ capability: "model.text_generation", support: "supported" });
    expect(await definition.adapter.invoke({ messages: [{ role: "user", content: "x" }], output: { kind: "text" } }, { signal: new AbortController().signal })).toEqual(succeeded("first"));
    expect(Object.isFrozen(definition) && Object.isFrozen(definition.manifest) && Object.isFrozen(definition.adapter)).toBe(true);
  });

  it("refuses another kind, a missing invoke, an invalid manifest, and an unsupported contract version", () => {
    const tool = { id: "x", version: "1.0.0", kind: "tool_provider" as const, capabilities: [{ capability: "tool.discovery" as const, support: "supported" as const }, { capability: "tool.execution" as const, support: "supported" as const }, { capability: "tool.retryable_failure" as const, support: "unsupported" as const }] };
    expect(() => defineModelAdapter({ manifest: tool, adapter: { invoke: async () => succeeded("x") } })).toThrow(/ADAPTER_KIND_MISMATCH/);
    expect(() => defineModelAdapter({ manifest: manifest(), adapter: {} as never })).toThrow(/ADAPTER_IMPLEMENTATION_INVALID/);
    expect(() => defineModelAdapter({ manifest: { ...manifest(), apiKey: "sk-1" } as never, adapter: { invoke: async () => succeeded("x") } })).toThrow(/ADAPTER_MANIFEST_INVALID/);
    expect(() => defineModelAdapter({ manifest: { ...manifest(), adapterContractVersion: 2 } as never, adapter: { invoke: async () => succeeded("x") } })).toThrow(AdapterContractError);
  });

  it("the Vercel AI SDK adapter ships a truthful manifest and a registrable definition", () => {
    expect(VERCEL_AI_SDK_ADAPTER_MANIFEST).toMatchObject({ id: "aao.vercel-ai-sdk", version: "1.0.0", kind: "model", adapterContractVersion: 1 });
    expect(VERCEL_AI_SDK_ADAPTER_MANIFEST.capabilities.every((entry) => entry.support === "supported")).toBe(true);
    const model = new MockLanguageModelV3({ doGenerate: async () => { throw new Error("unused"); } });
    expect(defineVercelAiModelAdapter({ model }).manifest).toEqual(VERCEL_AI_SDK_ADAPTER_MANIFEST);
  });
});

describe("AbortSignal: one cancellation lineage from caller to adapter", () => {
  it("executeModelRequest hands the caller's own signal to the adapter, unchanged", async () => {
    const controller = new AbortController();
    let seen: ModelAdapterContext | undefined;
    const { models, policies } = buildRegistries([{ id: "local", priority: 1, capabilities: TEXT_ONLY, adapter: { invoke: async (_request, context) => { seen = context; return succeeded("ok"); } } }]);
    await executeModelRequest({ request: buildTextRequest(), modelPolicyRef: "policy.default", policies, models, signal: controller.signal });
    expect(seen!.signal).toBe(controller.signal);
    expect(Object.isFrozen(seen)).toBe(true);
  });

  it("without a caller signal the adapter still receives one, which never aborts", async () => {
    let seen: AbortSignal | undefined;
    const { models, policies } = buildRegistries([{ id: "local", priority: 1, capabilities: TEXT_ONLY, adapter: { invoke: async (_request, context) => { seen = context.signal; return succeeded("ok"); } } }]);
    await executeModelRequest({ request: buildTextRequest(), modelPolicyRef: "policy.default", policies, models });
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen!.aborted).toBe(false);
  });

  it("an already-aborted signal invokes nothing and reports no model call", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const started: unknown[] = [];
    const { models, policies } = buildRegistries([{ id: "local", priority: 1, capabilities: TEXT_ONLY, adapter: { invoke: async () => { calls += 1; return succeeded("ok"); } } }]);
    const outcome = await executeModelRequest({ request: buildTextRequest(), modelPolicyRef: "policy.default", policies, models, signal: controller.signal, observer: { started: (info) => { started.push(info); } } });
    expect(outcome).toMatchObject({ ok: false, failure: { code: "MODEL_INVOCATION_FAILED", details: { reason: "cancelled" } } });
    expect(calls).toBe(0);
    expect(started).toEqual([]);
  });

  it("the model node passes the Runtime attempt's signal: an attempt timeout aborts it at the adapter, and the late result never commits", async () => {
    let signal: AbortSignal | undefined;
    let release!: () => void;
    const adapter: ModelAdapter = {
      invoke: (_request, context) => {
        signal = context.signal;
        return new Promise((resolve) => { release = () => resolve(succeeded("too late")); });
      },
    };
    const { models, policies } = buildRegistries([{ id: "local", priority: 1, capabilities: TEXT_ONLY, adapter }]);
    const registry = createNodeRegistry();
    registry.register(createModelNodeExecutor({ models, policies }));
    registry.register(finalOutputExecutor);
    const compiled = compileWorkflowSource(JSON.stringify({ schemaVersion: 1, id: "t.model", version: "1.0.0", name: "t", entryNodeId: "answer", nodes: [{ id: "answer", kind: "model", config: { modelPolicyRef: "policy.default", requestStateKey: "request", resultStateKey: "result" } }, { id: "final", kind: "final_output", config: {} }], edges: [{ sourceNodeId: "answer", targetNodeId: "final" }] }), "json");
    if (!compiled.ok) throw new Error("compile");
    const result = await executeWorkflow({ runId: "run.t", plan: compiled.plan, registry, initialState: { runId: "run.t", revision: 0, values: { request: buildTextRequest() } }, options: { sleeper: { sleep: () => new Promise((resolve) => setImmediate(resolve)) }, reliability: { policiesByNodeId: { answer: { maxAttempts: 1, attemptTimeoutMs: 5 } } } } });
    expect(signal!.aborted).toBe(true);
    expect(result).toMatchObject({ ok: false, failure: { code: "NODE_ATTEMPT_TIMEOUT", category: "TIMEOUT" } });
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(result.execution!.state.values.result).toBeUndefined();
    expect(result.execution!.run.status).toBe("FAILED");
  });

  it("the Vercel AI SDK adapter forwards the signal to the SDK's abortSignal, so the provider call observes the abort", async () => {
    let providerSignal: AbortSignal | undefined;
    const model = new MockLanguageModelV3({
      doGenerate: ((options: { abortSignal?: AbortSignal }) => {
        providerSignal = options.abortSignal;
        return new Promise((_resolve, reject) => options.abortSignal?.addEventListener("abort", () => reject(new Error("aborted sk-live-SECRET")), { once: true }));
      }) as never,
    });
    const controller = new AbortController();
    const pending = createVercelAiModelAdapter({ model }).invoke({ messages: [{ role: "user", content: "hi" }], output: { kind: "text" } }, { signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    expect(providerSignal?.aborted).toBe(false);
    controller.abort();
    expect(providerSignal?.aborted).toBe(true);
    const result = await pending;
    expect(result).toEqual({ status: "failed", reason: "provider_error" });
    expect(JSON.stringify(result)).not.toContain("sk-live");
  });
});
