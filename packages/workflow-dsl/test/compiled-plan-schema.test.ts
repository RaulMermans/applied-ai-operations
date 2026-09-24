import { describe, expect, it } from "vitest";
import { CompiledWorkflowPlanSchema } from "../src/compiled-plan-schema.js";
import { compileWorkflow } from "../src/compiler.js";
import { minimalValidWorkflow } from "./fixtures.js";

describe("CompiledWorkflowPlanSchema", () => {
  it("accepts a plan produced by compileWorkflow", () => {
    const result = compileWorkflow(minimalValidWorkflow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = CompiledWorkflowPlanSchema.safeParse(result.plan);
    expect(parsed.success).toBe(true);
  });

  it("round-trips through JSON.stringify -> JSON.parse and still validates", () => {
    const result = compileWorkflow(minimalValidWorkflow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const roundTripped = JSON.parse(JSON.stringify(result.plan));
    expect(CompiledWorkflowPlanSchema.safeParse(roundTripped).success).toBe(true);
  });

  it("rejects a plan missing required fields", () => {
    const parsed = CompiledWorkflowPlanSchema.safeParse({ schemaVersion: 1 });
    expect(parsed.success).toBe(false);
  });

  it("rejects a plan with an unexpected extra field", () => {
    const result = compileWorkflow(minimalValidWorkflow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const corrupted = { ...result.plan, extra: "not allowed" };
    expect(CompiledWorkflowPlanSchema.safeParse(corrupted).success).toBe(false);
  });

  it("rejects a plan whose entryNodeId does not appear as a plain identifier", () => {
    const parsed = CompiledWorkflowPlanSchema.safeParse({
      schemaVersion: 1,
      workflow: minimalValidWorkflow,
      entryNodeId: "",
      nodesById: {},
      outgoingEdgesByNode: {},
      incomingEdgesByNode: {},
      terminalNodeIds: [],
    });
    expect(parsed.success).toBe(false);
  });
});
