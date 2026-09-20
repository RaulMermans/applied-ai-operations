import { describe, expect, it } from "vitest";
import { executeWorkflow, sampleWorkflow, validateWorkflow, WorkflowValidationError } from "../src/workflow.js";

describe("AAO-neutral workflow compiled to LangGraph", () => {
  it("executes a valid workflow without exposing graph types in its contract", async () => {
    const result = await executeWorkflow(sampleWorkflow, "  Revenue  ");
    expect(result.normalized).toBe("revenue");
    expect(result.route).toBe("long");
    expect(result.output).toBe("long:classified:revenue");
  });

  it("fails clearly for an invalid branch route", () => {
    expect(() => validateWorkflow({
      ...sampleWorkflow,
      edges: sampleWorkflow.edges.filter((edge) => edge.route !== "long"),
    })).toThrow(new WorkflowValidationError("Branch choose is missing route: long"));
  });
});
