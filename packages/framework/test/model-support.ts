import type { AdapterManifestInput, DeterministicExecutor, JsonObject, ModelAdapter, ModelAdapterResult, ModelPolicySpec, Workflow } from "../src/index.js";

/** A plain host model adapter manifest: everything supported except tool-call responses. Fresh object per call. */
export function nativeManifest(overrides: Partial<AdapterManifestInput> = {}): AdapterManifestInput {
  return {
    id: "host.native-model",
    version: "1.0.0",
    kind: "model",
    capabilities: [
      { capability: "model.text_generation", support: "supported" },
      { capability: "model.structured_output", support: "supported" },
      { capability: "model.usage", support: "supported" },
      { capability: "model.cancellation", support: "supported" },
      { capability: "model.tool_call_response", support: "unsupported" },
    ],
    ...overrides,
  };
}

/** A scripted adapter that records the signal of every call. */
export function scriptedModel(responses: Array<ModelAdapterResult | Error | "block">): ModelAdapter & { calls: number; signals: AbortSignal[] } {
  const queue = [...responses];
  const adapter = {
    calls: 0,
    signals: [] as AbortSignal[],
    async invoke(_request: unknown, context: { signal: AbortSignal }): Promise<ModelAdapterResult> {
      adapter.calls += 1;
      adapter.signals.push(context.signal);
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      if (next instanceof Error) throw next;
      if (next === "block") return new Promise((resolve) => context.signal.addEventListener("abort", () => resolve({ status: "succeeded", output: { category: "late" }, finishReason: "stop" }), { once: true }));
      return next;
    },
  };
  return adapter;
}

export const structured = (output: JsonObject): ModelAdapterResult => ({ status: "succeeded", output, finishReason: "stop", usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 } });
export const agentDecision = (action: "CONTINUE" | "COMPLETE", output: string): ModelAdapterResult => ({ status: "succeeded", output: { action, output }, finishReason: "stop" });

export const classificationPolicy: ModelPolicySpec = { schemaVersion: 1, id: "policy.classification", version: "1.0.0", name: "Classification policy" };
export const binding = (adapterRef = { id: "host.native-model", version: "1.0.0" }) => ({ id: "classifier", priority: 10, capabilities: ["model.text_generation", "model.structured_output"] as const, identity: { provider: "host", model: "scripted" }, adapterRef });

export const CATEGORY_SCHEMA = { type: "object", properties: { category: { type: "string", enum: ["research", "sales", "support"] } }, required: ["category"], additionalProperties: false };

/** Builds the canonical ModelRequest from state: trusted host code, referenced by exact executorRef. */
export const prepareRequest: DeterministicExecutor = {
  id: "classify.prepare-request",
  version: "1.0.0",
  async execute({ state }) {
    const company = String(state.values.company);
    return {
      ok: true,
      statePatch: {
        classificationRequest: { schemaVersion: 1, invocationId: `inv.${company}`, messages: [{ role: "user", content: `Classify the request about ${company}.` }], output: { kind: "structured", schema: CATEGORY_SCHEMA, name: "classification" } },
        accountRequest: { accountId: company },
      },
    };
  },
};

/** prepare (deterministic) → classify (model) → final. Vendor-free: only a model policy reference. */
export function modelWorkflow(): Workflow {
  return {
    schemaVersion: 1, id: "test.classify", version: "1.0.0", name: "Classify", entryNodeId: "prepare",
    nodes: [
      { id: "prepare", kind: "deterministic", config: { executorRef: { id: "classify.prepare-request", version: "1.0.0" } } },
      { id: "classify", kind: "model", config: { modelPolicyRef: "policy.classification", requestStateKey: "classificationRequest", resultStateKey: "classification" } },
      { id: "final", kind: "final_output", config: {} },
    ],
    edges: [{ sourceNodeId: "prepare", targetNodeId: "classify" }, { sourceNodeId: "classify", targetNodeId: "final" }],
  };
}

/** act (agent) → final. The Agent and its model policy are registered host configuration. */
export function agentWorkflow(): Workflow {
  return {
    schemaVersion: 1, id: "test.agent", version: "1.0.0", name: "Agent", entryNodeId: "act",
    nodes: [
      { id: "act", kind: "agent", config: { agentRef: { id: "research.synthesizer", version: "1.0.0" }, taskStateKey: "task", resultStateKey: "synthesis" } },
      { id: "final", kind: "final_output", config: {} },
    ],
    edges: [{ sourceNodeId: "act", targetNodeId: "final" }],
  };
}

export const synthesizer = (maxIterations = 3, toolRefs: string[] = []) => ({
  spec: { schemaVersion: 1 as const, id: "research.synthesizer", version: "1.0.0", name: "Synthesizer", modelPolicyRef: "policy.classification", toolRefs, skillRefs: [], permissionClasses: ["read_only" as const] },
  instructions: "Synthesize the research findings concisely.",
  limits: { maxIterations, maxOutputTokensPerIteration: 256 },
});
