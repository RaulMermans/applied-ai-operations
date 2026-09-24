import { describe, expect, it } from "vitest";
import { createModelRegistry, type ModelBinding } from "../src/registry.js";
import { deriveRequiredCapabilities, selectModelBinding } from "../src/router.js";
import { TEXT_AND_STRUCTURED, TEXT_ONLY, buildPolicy, buildStructuredRequest, buildTextRequest, spyAdapter, succeeded } from "./fixtures.js";

const adapter = spyAdapter(succeeded("x"));

function registryOf(bindings: Omit<ModelBinding, "adapter">[]) {
  const registry = createModelRegistry();
  for (const binding of bindings) registry.register({ ...binding, adapter });
  return registry;
}

const standard = [
  { id: "model.fast", priority: 20, capabilities: TEXT_ONLY },
  { id: "model.structured", priority: 10, capabilities: TEXT_AND_STRUCTURED },
];

describe("deriveRequiredCapabilities", () => {
  it("text output implies model.text_generation", () => {
    expect(deriveRequiredCapabilities(buildTextRequest(), buildPolicy())).toEqual(["model.text_generation"]);
  });

  it("structured output implies model.structured_output", () => {
    expect(deriveRequiredCapabilities(buildStructuredRequest(), buildPolicy())).toEqual(["model.structured_output"]);
  });

  it("is the sorted, deduplicated union of policy, request, and output-implied capabilities", () => {
    const request = buildTextRequest({ requiredCapabilities: ["model.text_generation", "model.structured_output"] });
    const policy = buildPolicy({ requiredCapabilities: ["model.structured_output", "vendor.custom"] });
    expect(deriveRequiredCapabilities(request, policy)).toEqual(["model.structured_output", "model.text_generation", "vendor.custom"]);
  });
});

describe("selectModelBinding", () => {
  it("text route: picks the highest-priority text-capable binding", () => {
    expect(selectModelBinding(["model.text_generation"], registryOf(standard))?.id).toBe("model.fast");
  });

  it("structured route: excludes bindings without model.structured_output", () => {
    expect(selectModelBinding(["model.structured_output"], registryOf(standard))?.id).toBe("model.structured");
  });

  it("request/policy requirements filter candidates", () => {
    expect(selectModelBinding(["model.structured_output", "model.text_generation"], registryOf(standard))?.id).toBe("model.structured");
  });

  it("returns undefined when no binding declares every required capability", () => {
    expect(selectModelBinding(["model.structured_output"], registryOf([standard[0]!]))).toBeUndefined();
    expect(selectModelBinding(["vendor.custom"], registryOf(standard))).toBeUndefined();
    expect(selectModelBinding(["model.text_generation"], registryOf([]))).toBeUndefined();
  });

  it("higher explicit priority wins over id order", () => {
    const registry = registryOf([
      { id: "a.low", priority: 1, capabilities: TEXT_ONLY },
      { id: "z.high", priority: 5, capabilities: TEXT_ONLY },
    ]);
    expect(selectModelBinding(["model.text_generation"], registry)?.id).toBe("z.high");
  });

  it("equal priority ties break by stable binding id, independent of registration order", () => {
    const bindings = [
      { id: "tie.charlie", priority: 7, capabilities: TEXT_ONLY },
      { id: "tie.alpha", priority: 7, capabilities: TEXT_ONLY },
      { id: "tie.bravo", priority: 7, capabilities: TEXT_ONLY },
    ];
    const orders = [bindings, [...bindings].reverse(), [bindings[1]!, bindings[2]!, bindings[0]!]];
    for (const order of orders) {
      expect(selectModelBinding(["model.text_generation"], registryOf(order))?.id).toBe("tie.alpha");
    }
  });

  it("is deterministic across repeated calls and fresh registries with the same definitions", () => {
    const picks = Array.from({ length: 20 }, () => selectModelBinding(["model.text_generation"], registryOf(standard))?.id);
    expect(new Set(picks)).toEqual(new Set(["model.fast"]));
  });
});
