import type { ModelPolicySpec } from "@aao/contracts";
import { createModelPolicyRegistry, type ModelPolicyRegistry } from "../src/policy-registry.js";
import { createModelRegistry, type ModelBinding, type ModelRegistry } from "../src/registry.js";
import type { ModelAdapter, ModelAdapterRequest, ModelAdapterResult, ModelCapabilityId, ModelRequest } from "../src/types.js";

export const TEXT_ONLY: ModelCapabilityId[] = ["model.text_generation"];
export const TEXT_AND_STRUCTURED: ModelCapabilityId[] = ["model.text_generation", "model.structured_output"];

export function buildPolicy(overrides: Partial<ModelPolicySpec> = {}): ModelPolicySpec {
  return { schemaVersion: 1, id: "policy.default", version: "1.0.0", name: "Default model policy", ...overrides };
}

export function buildTextRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    schemaVersion: 1,
    invocationId: "inv.text.1",
    messages: [
      { role: "system", content: "You are concise." },
      { role: "user", content: "Say hello." },
    ],
    output: { kind: "text" },
    ...overrides,
  };
}

export const CATEGORY_SCHEMA = {
  type: "object",
  properties: { category: { type: "string", enum: ["research", "sales", "support"] } },
  required: ["category"],
  additionalProperties: false,
};

export function buildStructuredRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    schemaVersion: 1,
    invocationId: "inv.structured.1",
    messages: [{ role: "user", content: "Classify: quarterly market study." }],
    output: { kind: "structured", schema: CATEGORY_SCHEMA, name: "classification" },
    ...overrides,
  };
}

/** A deterministic spy adapter: records every request and returns (or throws) a scripted response. */
export function spyAdapter(respond: ((request: ModelAdapterRequest) => unknown) | unknown): ModelAdapter & { calls: ModelAdapterRequest[] } {
  const calls: ModelAdapterRequest[] = [];
  return {
    calls,
    async invoke(request) {
      calls.push(request);
      return (typeof respond === "function" ? (respond as (r: ModelAdapterRequest) => unknown)(request) : respond) as ModelAdapterResult;
    },
  };
}

export function succeeded(output: unknown, extra: Partial<Extract<ModelAdapterResult, { status: "succeeded" }>> = {}): ModelAdapterResult {
  return { status: "succeeded", output, ...extra };
}

export function buildRegistries(bindings: ModelBinding[], policies: ModelPolicySpec[] = [buildPolicy()]): { models: ModelRegistry; policies: ModelPolicyRegistry } {
  const models = createModelRegistry();
  for (const binding of bindings) models.register(binding);
  const policyRegistry = createModelPolicyRegistry();
  for (const policy of policies) policyRegistry.register(policy);
  return { models, policies: policyRegistry };
}
