import { describe, expect, it } from "vitest";
import { EvalDefinitionSchema, EvalModeSchema, EvalResultSchema } from "../src/evaluation.js";

describe("EvalModeSchema", () => {
  it.each((["OFFLINE", "RUNTIME"] as const).map((mode) => [mode]))("accepts canonical mode %s", (mode) => {
    expect(EvalModeSchema.safeParse(mode).success).toBe(true);
  });

  it("rejects an invalid mode", () => {
    expect(EvalModeSchema.safeParse("BATCH").success).toBe(false);
  });
});

describe("EvalDefinitionSchema", () => {
  it("parses an offline definition", () => {
    expect(
      EvalDefinitionSchema.safeParse({
        schemaVersion: 1,
        id: "eval.grounding-check",
        version: "1.0.0",
        name: "Grounding check",
        mode: "OFFLINE",
        targetType: "artifact",
      }).success,
    ).toBe(true);
  });

  it("parses a runtime definition", () => {
    expect(
      EvalDefinitionSchema.safeParse({
        schemaVersion: 1,
        id: "eval.authorization-guard",
        version: "1.0.0",
        name: "Authorization guard",
        mode: "RUNTIME",
        targetType: "authorization",
      }).success,
    ).toBe(true);
  });

  it("rejects an invalid target type", () => {
    expect(
      EvalDefinitionSchema.safeParse({
        schemaVersion: 1,
        id: "eval.x",
        version: "1.0.0",
        name: "X",
        mode: "OFFLINE",
        targetType: "gpa",
      }).success,
    ).toBe(false);
  });
});

describe("EvalResultSchema", () => {
  it("allows a passing result to exist without a numeric score", () => {
    expect(EvalResultSchema.safeParse({ evalId: "eval.authorization-guard", status: "passed" }).success).toBe(true);
  });

  it("validates allowed score semantics (0..1 inclusive)", () => {
    expect(EvalResultSchema.safeParse({ evalId: "eval.grounding-check", status: "passed", score: 0.87 }).success).toBe(true);
    expect(EvalResultSchema.safeParse({ evalId: "eval.grounding-check", status: "passed", score: 0 }).success).toBe(true);
    expect(EvalResultSchema.safeParse({ evalId: "eval.grounding-check", status: "passed", score: 1 }).success).toBe(true);
  });

  it("rejects a score outside 0..1", () => {
    expect(EvalResultSchema.safeParse({ evalId: "eval.grounding-check", status: "failed", score: 1.5 }).success).toBe(false);
    expect(EvalResultSchema.safeParse({ evalId: "eval.grounding-check", status: "failed", score: -0.1 }).success).toBe(false);
  });

  it("rejects a missing required field", () => {
    expect(EvalResultSchema.safeParse({ status: "passed" }).success).toBe(false);
  });

  it("parses a result with evidence refs and a reason", () => {
    expect(
      EvalResultSchema.safeParse({
        evalId: "eval.grounding-check",
        runId: "run-0001",
        status: "failed",
        score: 0.2,
        reason: "claim not supported by retrieved evidence",
        evidenceRefs: ["trace-event-0042"],
      }).success,
    ).toBe(true);
  });
});
