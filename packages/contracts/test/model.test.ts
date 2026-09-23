import { describe, expect, it } from "vitest";
import { ModelPolicySpecSchema } from "../src/model.js";

describe("ModelPolicySpecSchema", () => {
  const validPolicy = {
    schemaVersion: 1 as const,
    id: "default.reasoning-model",
    version: "1.0.0",
    name: "Default reasoning model policy",
    requiredCapabilities: ["structured-output"],
    constraints: { maxOutputTokens: 4096 },
  };

  it("parses a valid, minimal model policy", () => {
    expect(ModelPolicySpecSchema.safeParse({ schemaVersion: 1, id: "m", version: "1.0.0", name: "M" }).success).toBe(true);
  });

  it("parses a full model policy", () => {
    expect(ModelPolicySpecSchema.safeParse(validPolicy).success).toBe(true);
  });

  it("never requires a provider SDK type: constraints is a plain JSON-safe object", () => {
    expect(typeof validPolicy.constraints).toBe("object");
    expect(ModelPolicySpecSchema.safeParse(validPolicy).success).toBe(true);
  });

  it("rejects a non-JSON-safe constraints value", () => {
    expect(ModelPolicySpecSchema.safeParse({ ...validPolicy, constraints: { cb: () => 1 } }).success).toBe(false);
  });

  it("rejects an unexpected top-level field", () => {
    expect(ModelPolicySpecSchema.safeParse({ ...validPolicy, provider: "openai" }).success).toBe(false);
  });
});
