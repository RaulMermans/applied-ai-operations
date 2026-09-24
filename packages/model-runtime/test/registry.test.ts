import { describe, expect, it } from "vitest";
import { createModelPolicyRegistry, hasUnsupportedConstraints } from "../src/policy-registry.js";
import { createModelRegistry } from "../src/registry.js";
import { TEXT_AND_STRUCTURED, TEXT_ONLY, buildPolicy, spyAdapter, succeeded } from "./fixtures.js";

const adapter = spyAdapter(succeeded("x"));

describe("createModelRegistry", () => {
  it("registers bindings with explicit priority and capabilities", () => {
    const registry = createModelRegistry();
    registry.register({ id: "local.fast", priority: 10, capabilities: TEXT_ONLY, adapter });
    const binding = registry.get("local.fast");
    expect(binding?.priority).toBe(10);
    expect(binding?.capabilities).toEqual(["model.text_generation"]);
    expect(binding?.adapter).toBe(adapter);
  });

  it("rejects duplicate ids", () => {
    const registry = createModelRegistry();
    registry.register({ id: "local.fast", priority: 1, capabilities: TEXT_ONLY, adapter });
    expect(() => registry.register({ id: "local.fast", priority: 2, capabilities: TEXT_AND_STRUCTURED, adapter })).toThrow(/already registered/);
  });

  it("keeps registries isolated — no global state", () => {
    const a = createModelRegistry();
    const b = createModelRegistry();
    a.register({ id: "local.fast", priority: 1, capabilities: TEXT_ONLY, adapter });
    expect(b.get("local.fast")).toBeUndefined();
    expect(b.list()).toEqual([]);
    b.register({ id: "local.fast", priority: 1, capabilities: TEXT_ONLY, adapter });
  });

  it.each([
    ["non-identifier id", { id: "bad id", priority: 1, capabilities: TEXT_ONLY, adapter }],
    ["fractional priority", { id: "m", priority: 1.5, capabilities: TEXT_ONLY, adapter }],
    ["no capabilities", { id: "m", priority: 1, capabilities: [], adapter }],
    ["unknown capability", { id: "m", priority: 1, capabilities: ["model.tool_calling"], adapter }],
    ["missing adapter", { id: "m", priority: 1, capabilities: TEXT_ONLY, adapter: {} }],
  ])("rejects a binding with %s", (_label, binding) => {
    expect(() => createModelRegistry().register(binding as never)).toThrow();
  });

  it("lists bindings sorted by id, independent of registration order", () => {
    const a = createModelRegistry();
    a.register({ id: "z.model", priority: 1, capabilities: TEXT_ONLY, adapter });
    a.register({ id: "a.model", priority: 1, capabilities: TEXT_ONLY, adapter });
    expect(a.list().map((binding) => binding.id)).toEqual(["a.model", "z.model"]);
  });

  it("stores capabilities as a frozen copy", () => {
    const capabilities = [...TEXT_ONLY];
    const registry = createModelRegistry();
    registry.register({ id: "m", priority: 1, capabilities, adapter });
    capabilities.push("model.structured_output");
    expect(registry.get("m")?.capabilities).toEqual(["model.text_generation"]);
  });
});

describe("createModelPolicyRegistry", () => {
  it("registers and looks up a canonical ModelPolicySpec by id", () => {
    const registry = createModelPolicyRegistry();
    registry.register(buildPolicy({ id: "policy.structured", requiredCapabilities: ["model.structured_output"] }));
    expect(registry.get("policy.structured")?.requiredCapabilities).toEqual(["model.structured_output"]);
    expect(registry.get("policy.missing")).toBeUndefined();
  });

  it("rejects duplicate ids", () => {
    const registry = createModelPolicyRegistry();
    registry.register(buildPolicy());
    expect(() => registry.register(buildPolicy({ version: "2.0.0" }))).toThrow(/already registered/);
  });

  it("rejects a non-canonical policy", () => {
    expect(() => createModelPolicyRegistry().register({ ...buildPolicy(), provider: "openai" } as never)).toThrow(/canonical/);
  });

  it("keeps policy registries isolated and returns defensive copies", () => {
    const a = createModelPolicyRegistry();
    a.register(buildPolicy({ requiredCapabilities: ["model.text_generation"] }));
    expect(createModelPolicyRegistry().get("policy.default")).toBeUndefined();
    a.get("policy.default")?.requiredCapabilities?.push("model.structured_output");
    expect(a.get("policy.default")?.requiredCapabilities).toEqual(["model.text_generation"]);
  });

  it("treats absent/empty constraints as supported and any non-empty constraints as unsupported", () => {
    expect(hasUnsupportedConstraints(buildPolicy())).toBe(false);
    expect(hasUnsupportedConstraints(buildPolicy({ constraints: {} }))).toBe(false);
    expect(hasUnsupportedConstraints(buildPolicy({ constraints: { maxLatencyMs: 100 } }))).toBe(true);
  });
});
