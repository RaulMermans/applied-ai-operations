import { describe, expect, it } from "vitest";
import { createNodeRegistry } from "../src/registry.js";
import type { NodeExecutor } from "../src/types.js";

const deterministicExecutor: NodeExecutor = { kind: "deterministic", async execute() { return {}; } };
const finalOutputExecutor: NodeExecutor = { kind: "final_output", async execute() { return {}; } };

describe("createNodeRegistry", () => {
  it("starts empty", () => {
    const registry = createNodeRegistry();
    expect(registry.has("deterministic")).toBe(false);
    expect(registry.get("deterministic")).toBeUndefined();
  });

  it("registers and looks up an executor by kind", () => {
    const registry = createNodeRegistry();
    registry.register(deterministicExecutor);
    expect(registry.has("deterministic")).toBe(true);
    expect(registry.get("deterministic")).toBe(deterministicExecutor);
  });

  it("represents a missing executor as undefined, not a thrown error", () => {
    const registry = createNodeRegistry();
    registry.register(deterministicExecutor);
    expect(registry.get("model")).toBeUndefined();
    expect(registry.has("model")).toBe(false);
  });

  it("rejects a duplicate registration for the same kind", () => {
    const registry = createNodeRegistry();
    registry.register(deterministicExecutor);
    const other: NodeExecutor = { kind: "deterministic", async execute() { return {}; } };
    expect(() => registry.register(other)).toThrow(/already registered/);
  });

  it("only accepts canonical NodeKind values (enforced by the TypeScript NodeKind type, not a runtime check)", () => {
    const registry = createNodeRegistry();
    registry.register(finalOutputExecutor);
    expect(registry.has("final_output")).toBe(true);
    expect(registry.has("agent")).toBe(false);
  });

  it("keeps separate registry instances fully isolated", () => {
    const a = createNodeRegistry();
    const b = createNodeRegistry();
    a.register(deterministicExecutor);
    expect(a.has("deterministic")).toBe(true);
    expect(b.has("deterministic")).toBe(false);
  });

  it("is easy to construct fresh in a test with no shared/global state", () => {
    const first = createNodeRegistry();
    first.register(deterministicExecutor);
    const second = createNodeRegistry();
    expect(second.has("deterministic")).toBe(false);
    second.register(deterministicExecutor);
    expect(second.has("deterministic")).toBe(true);
  });
});
