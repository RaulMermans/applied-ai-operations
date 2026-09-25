import type { AgentSpec, ModelPolicySpec } from "@aao/contracts";
import {
  createModelPolicyRegistry,
  createModelRegistry,
  type ModelAdapter,
  type ModelAdapterRequest,
  type ModelAdapterResult,
  type ModelBinding,
  type ModelCapabilityId,
  type ModelUsage,
} from "@aao/model-runtime";
import { createAgentRegistry } from "../src/registry.js";
import type { AgentRuntimeDependencies } from "../src/controller.js";
import type { AgentExecutionRequest, RegisteredAgent } from "../src/types.js";

export const TEXT_AND_STRUCTURED: ModelCapabilityId[] = ["model.text_generation", "model.structured_output"];
export const TEXT_ONLY: ModelCapabilityId[] = ["model.text_generation"];

export const AGENT_REF = { id: "research.synthesizer", version: "1.0.0" } as const;

export function buildAgentSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    schemaVersion: 1,
    id: AGENT_REF.id,
    version: AGENT_REF.version,
    name: "Research synthesizer",
    modelPolicyRef: "policy.agent",
    skillRefs: [],
    toolRefs: [],
    permissionClasses: ["read_only"],
    ...overrides,
  };
}

export function buildAgent(overrides: { spec?: Partial<AgentSpec>; instructions?: string; limits?: Partial<RegisteredAgent["limits"]> } = {}): RegisteredAgent {
  return {
    spec: buildAgentSpec(overrides.spec),
    instructions: overrides.instructions ?? "Synthesize a concise research summary for the task.",
    limits: { maxIterations: 4, maxOutputTokensPerIteration: 512, ...overrides.limits },
  };
}

export function buildPolicy(overrides: Partial<ModelPolicySpec> = {}): ModelPolicySpec {
  return { schemaVersion: 1, id: "policy.agent", version: "1.0.0", name: "Agent model policy", ...overrides };
}

export function buildRequest(overrides: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest {
  return { schemaVersion: 1, agentExecutionId: "exec.1", agentRef: { ...AGENT_REF }, task: "Summarize the market for local-first workflow tools.", ...overrides };
}

export type ScriptedResponse = ModelAdapterResult | Error;

/**
 * A deterministic scripted adapter: call *n* returns (or, for an `Error`,
 * throws) `responses[n]`. Running past the script is a test bug and fails
 * loudly. Every request is recorded so tests can count model invocations.
 */
export function scriptedAdapter(responses: ScriptedResponse[]): ModelAdapter & { calls: ModelAdapterRequest[] } {
  const calls: ModelAdapterRequest[] = [];
  return {
    calls,
    async invoke(request) {
      const response = responses[calls.length];
      calls.push(JSON.parse(JSON.stringify(request)) as ModelAdapterRequest);
      if (response === undefined) throw new Error(`scriptedAdapter: unexpected call #${calls.length}`);
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

export function decision(action: string, output: string, usage?: ModelUsage): ModelAdapterResult {
  return { status: "succeeded", output: { action, output }, finishReason: "stop", ...(usage !== undefined ? { usage } : {}) };
}

export function rawOutput(output: unknown): ModelAdapterResult {
  return { status: "succeeded", output, finishReason: "stop" };
}

/**
 * The standard world: a primary structured-capable binding (priority 10) the
 * router always selects, plus a lower-priority *compatible* backup whose
 * adapter must never be called — making "no fallback" observable.
 */
export function buildWorld(
  primaryResponses: ScriptedResponse[],
  options: { agents?: RegisteredAgent[]; policies?: ModelPolicySpec[]; bindings?: ModelBinding[] } = {},
): AgentRuntimeDependencies & { primary: ReturnType<typeof scriptedAdapter>; backup: ReturnType<typeof scriptedAdapter> } {
  const primary = scriptedAdapter(primaryResponses);
  const backup = scriptedAdapter([]);
  const models = createModelRegistry();
  for (const binding of options.bindings ?? [
    { id: "local.primary", priority: 10, capabilities: TEXT_AND_STRUCTURED, adapter: primary },
    { id: "local.backup", priority: 1, capabilities: TEXT_AND_STRUCTURED, adapter: backup },
  ]) {
    models.register(binding);
  }
  const policies = createModelPolicyRegistry();
  for (const policy of options.policies ?? [buildPolicy()]) policies.register(policy);
  const agents = createAgentRegistry();
  for (const agent of options.agents ?? [buildAgent()]) agents.register(agent);
  return { agents, policies, models, primary, backup };
}
