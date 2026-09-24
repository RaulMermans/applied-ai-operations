import type { ModelPolicySpec } from "@aao/contracts";
import { compareIds, type ModelBinding, type ModelRegistry } from "./registry.js";
import type { ModelCapabilityId, ModelRequest } from "./types.js";

const CAPABILITY_IMPLIED_BY_OUTPUT: Record<ModelRequest["output"]["kind"], ModelCapabilityId> = {
  text: "model.text_generation",
  structured: "model.structured_output",
};

/**
 * The routing requirement set: policy-required ∪ request-required ∪ the
 * capability implied by the output kind, deduplicated and sorted. Policy
 * capabilities are canonical identifiers that may name a capability no
 * binding can declare — that simply yields no route (fail closed).
 */
export function deriveRequiredCapabilities(request: ModelRequest, policy: ModelPolicySpec): string[] {
  const required = new Set<string>([
    ...(policy.requiredCapabilities ?? []),
    ...(request.requiredCapabilities ?? []),
    CAPABILITY_IMPLIED_BY_OUTPUT[request.output.kind],
  ]);
  return [...required].sort(compareIds);
}

/**
 * Deterministic capability routing: keep bindings that declare every
 * required capability, prefer the highest explicit `priority`, and break
 * ties by binding id. No model, randomness, latency, cost, history, or
 * registration order participates. Returns `undefined` when nothing
 * qualifies. Exactly one binding is ever chosen — there is no fallback list.
 */
export function selectModelBinding(required: readonly string[], registry: ModelRegistry): ModelBinding | undefined {
  const candidates = registry.list().filter((binding) => required.every((capability) => (binding.capabilities as readonly string[]).includes(capability)));
  candidates.sort((a, b) => b.priority - a.priority || compareIds(a.id, b.id));
  return candidates[0];
}
