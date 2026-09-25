import { describe, expect, it, vi } from "vitest";
import { deriveToolExecutionId } from "../src/execution-id.js";
import { ToolExecutionRequestSchema } from "../src/types.js";
import { LOOKUP_REF, maxLengthId } from "./fixtures.js";

describe("deriveToolExecutionId", () => {
  it("derives a bounded, schema-valid id from maximum-length Run and Node ids", () => {
    const id = deriveToolExecutionId(maxLengthId("run"), maxLengthId("node"));
    expect(id).toMatch(/^tool\.[0-9a-f]{64}$/);
    expect(id).toHaveLength(69);
    expect(ToolExecutionRequestSchema.safeParse({ schemaVersion: 1, toolExecutionId: id, toolRef: { ...LOOKUP_REF }, input: {} }).success).toBe(true);
  });

  it("same Run + Node → identical id; different Run or Node → different id; unambiguous where concatenation collides", () => {
    expect(deriveToolExecutionId("run.a", "lookup")).toBe(deriveToolExecutionId("run.a", "lookup"));
    expect(deriveToolExecutionId("run.a", "lookup")).not.toBe(deriveToolExecutionId("run.b", "lookup"));
    expect(deriveToolExecutionId("run.a", "lookup")).not.toBe(deriveToolExecutionId("run.a", "transform"));
    expect(deriveToolExecutionId("a.b", "c")).not.toBe(deriveToolExecutionId("a", "b.c"));
  });

  it("is domain-separated from the Agent derivation of the same Run + Node", () => {
    // The Agent Runtime's pinned digest for ("run.a", "research"); a different domain tag yields a different digest.
    const agentDigest = "b14c152401747364db7dddf0d4b23a894da11b12131bff4895365572da6f98f8";
    expect(deriveToolExecutionId("run.a", "research").slice("tool.".length)).not.toBe(agentDigest);
  });

  it("has no random or time dependency", () => {
    const before = deriveToolExecutionId("run.a", "lookup");
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      expect(deriveToolExecutionId("run.a", "lookup")).toBe(before);
    } finally {
      random.mockRestore();
      now.mockRestore();
    }
    expect(before).toBe("tool.c35c352e413a0ad7d5749c550584b438d18a7a2a59f58a457a48d2d944fe777d");
  });

  it("rejects non-canonical inputs as a programming error", () => {
    expect(() => deriveToolExecutionId("", "lookup")).toThrow();
    expect(() => deriveToolExecutionId("run.a", "has space")).toThrow();
  });
});
