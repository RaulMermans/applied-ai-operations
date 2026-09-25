import { describe, expect, it } from "vitest";
import { createModelPolicyRegistry } from "@aao/model-runtime";
import { createAgentRegistry } from "../src/registry.js";
import { resolveExecutableAgent } from "../src/resolution.js";
import { MAX_AGENT_ITERATIONS_CEILING, MAX_OUTPUT_TOKENS_PER_ITERATION_CEILING, type RegisteredAgent } from "../src/types.js";
import { AGENT_REF, buildAgent, buildPolicy } from "./fixtures.js";

describe("Agent Registry", () => {
  it("registers an agent and returns it intact (canonical AgentSpec retained) by exact reference", () => {
    const registry = createAgentRegistry();
    const agent = buildAgent();
    registry.register(agent);
    expect(registry.get(AGENT_REF)).toEqual(agent);
  });

  it("rejects a duplicate id@version", () => {
    const registry = createAgentRegistry();
    registry.register(buildAgent());
    expect(() => registry.register(buildAgent({ instructions: "Different instructions." }))).toThrow(/already registered/);
  });

  it("allows two versions of one agent and resolves each version exactly (no 'latest')", () => {
    const registry = createAgentRegistry();
    registry.register(buildAgent({ limits: { maxIterations: 2 } }));
    registry.register(buildAgent({ spec: { version: "2.0.0" }, limits: { maxIterations: 6 } }));
    expect(registry.get({ id: AGENT_REF.id, version: "1.0.0" })?.limits.maxIterations).toBe(2);
    expect(registry.get({ id: AGENT_REF.id, version: "2.0.0" })?.limits.maxIterations).toBe(6);
    expect(registry.get({ id: AGENT_REF.id, version: "3.0.0" })).toBeUndefined();
    expect(registry.get({ id: AGENT_REF.id, version: "1" })).toBeUndefined();
    expect(registry.get({ id: "research.other", version: "1.0.0" })).toBeUndefined();
  });

  it("registries are isolated instances — no global singleton", () => {
    const a = createAgentRegistry();
    const b = createAgentRegistry();
    a.register(buildAgent());
    expect(a.get(AGENT_REF)).toBeDefined();
    expect(b.get(AGENT_REF)).toBeUndefined();
  });

  it("returns defensive clones: mutating a returned or registered object cannot change the registered agent", () => {
    const registry = createAgentRegistry();
    const agent = buildAgent();
    registry.register(agent);
    agent.limits.maxIterations = 16;
    const fetched = registry.get(AGENT_REF)!;
    fetched.limits.maxIterations = 16;
    fetched.spec.toolRefs.push("email.send");
    expect(registry.get(AGENT_REF)?.limits.maxIterations).toBe(4);
    expect(registry.get(AGENT_REF)?.spec.toolRefs).toEqual([]);
  });

  it("an id/version pair cannot collide with another via a separator", () => {
    const registry = createAgentRegistry();
    registry.register(buildAgent({ spec: { id: "a.b", version: "c" } }));
    expect(registry.get({ id: "a", version: "b.c" })).toBeUndefined();
  });

  it.each<[string, Partial<RegisteredAgent["limits"]>]>([
    ["maxIterations 0 (no 'unlimited' sentinel)", { maxIterations: 0 }],
    ["maxIterations above the V1 ceiling", { maxIterations: MAX_AGENT_ITERATIONS_CEILING + 1 }],
    ["maxIterations Infinity", { maxIterations: Number.POSITIVE_INFINITY }],
    ["maxIterations MAX_SAFE_INTEGER", { maxIterations: Number.MAX_SAFE_INTEGER }],
    ["maxIterations non-integer", { maxIterations: 2.5 }],
    ["maxIterations negative", { maxIterations: -1 }],
    ["maxOutputTokensPerIteration 0", { maxOutputTokensPerIteration: 0 }],
    ["maxOutputTokensPerIteration above the ceiling", { maxOutputTokensPerIteration: MAX_OUTPUT_TOKENS_PER_ITERATION_CEILING + 1 }],
    ["maxOutputTokensPerIteration Infinity", { maxOutputTokensPerIteration: Number.POSITIVE_INFINITY }],
  ])("rejects invalid limits: %s", (_label, limits) => {
    expect(() => createAgentRegistry().register(buildAgent({ limits }))).toThrow(/RegisteredAgentSchema/);
  });

  it("accepts the V1 boundaries exactly", () => {
    const registry = createAgentRegistry();
    registry.register(buildAgent({ limits: { maxIterations: 1, maxOutputTokensPerIteration: 1 } }));
    registry.register(buildAgent({ spec: { version: "2" }, limits: { maxIterations: MAX_AGENT_ITERATIONS_CEILING, maxOutputTokensPerIteration: MAX_OUTPUT_TOKENS_PER_ITERATION_CEILING } }));
    expect(MAX_AGENT_ITERATIONS_CEILING).toBe(16);
  });

  it.each([
    ["missing limits", { ...buildAgent(), limits: undefined }],
    ["blank instructions", buildAgent({ instructions: "   " })],
    ["a non-canonical AgentSpec (unknown field)", { ...buildAgent(), spec: { ...buildAgent().spec, autonomous: true } }],
    ["an extra binding field (prompt template)", { ...buildAgent(), promptTemplate: "{{task}}" }],
    ["an unlimited-mode flag in limits", { ...buildAgent(), limits: { maxIterations: 4, maxOutputTokensPerIteration: 512, unlimited: true } }],
  ])("rejects %s", (_label, agent) => {
    expect(() => createAgentRegistry().register(agent as RegisteredAgent)).toThrow(/RegisteredAgentSchema/);
  });
});

describe("resolveExecutableAgent — unsupported features fail closed", () => {
  function resolve(agent: RegisteredAgent, policies = [buildPolicy()]) {
    const agents = createAgentRegistry();
    agents.register(agent);
    const policyRegistry = createModelPolicyRegistry();
    for (const policy of policies) policyRegistry.register(policy);
    return resolveExecutableAgent({ id: agent.spec.id, version: agent.spec.version }, { agents, policies: policyRegistry });
  }

  it("resolves a supported agent with its registered model policy", () => {
    const resolution = resolve(buildAgent({ spec: { permissionClasses: ["read_only", "write_draft"] } }));
    expect(resolution.ok && resolution.modelPolicyRef).toBe("policy.agent");
  });

  it("AGENT_NOT_FOUND for an unknown reference", () => {
    const resolution = resolveExecutableAgent(AGENT_REF, { agents: createAgentRegistry(), policies: createModelPolicyRegistry() });
    expect(!resolution.ok && resolution.failure.code).toBe("AGENT_NOT_FOUND");
  });

  it.each<[string, Parameters<typeof buildAgent>[0], string]>([
    ["non-empty toolRefs", { spec: { toolRefs: ["email.send"] } }, "toolRefs"],
    ["non-empty skillRefs", { spec: { skillRefs: ["research.company-profile"] } }, "skillRefs"],
    ["no modelPolicyRef", { spec: { modelPolicyRef: undefined } }, "modelPolicyRef"],
    ["external_side_effect permission", { spec: { permissionClasses: ["external_side_effect"] } }, "permissionClasses"],
    ["destructive permission", { spec: { permissionClasses: ["read_only", "destructive"] } }, "permissionClasses"],
    ["sensitive_data permission", { spec: { permissionClasses: ["read_only", "sensitive_data"] } }, "permissionClasses"],
  ])("UNSUPPORTED_AGENT_CONFIGURATION for %s", (_label, overrides, issuePrefix) => {
    const resolution = resolve(buildAgent(overrides));
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.failure.code).toBe("UNSUPPORTED_AGENT_CONFIGURATION");
    expect(resolution.failure.issues?.some((issue) => issue.startsWith(issuePrefix))).toBe(true);
  });

  it("AGENT_MODEL_POLICY_NOT_FOUND when the referenced policy is not registered", () => {
    const resolution = resolve(buildAgent({ spec: { modelPolicyRef: "policy.missing" } }));
    expect(!resolution.ok && resolution.failure.code).toBe("AGENT_MODEL_POLICY_NOT_FOUND");
  });

  it("UNSUPPORTED_AGENT_CONFIGURATION when the policy has constraints Model Runtime V1 cannot enforce", () => {
    const resolution = resolve(buildAgent(), [buildPolicy({ constraints: { tier: "gold" } })]);
    expect(!resolution.ok && resolution.failure.code).toBe("UNSUPPORTED_AGENT_CONFIGURATION");
  });
});
