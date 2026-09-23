import { describe, expect, it } from "vitest";
import { validateWorkflowSemantics } from "../src/semantic-validator.js";
import { buildWorkflow } from "./fixtures.js";

describe("validateWorkflowSemantics — terminal semantics", () => {
  it("accepts a final_output node with zero outgoing edges", () => {
    const workflow = buildWorkflow({
      entryNodeId: "intake",
      nodes: [
        { id: "intake", kind: "deterministic", config: {} },
        { id: "final", kind: "final_output", config: {} },
      ],
      edges: [{ sourceNodeId: "intake", targetNodeId: "final" }],
    });
    expect(validateWorkflowSemantics(workflow)).toEqual([]);
  });

  it("rejects a final_output node with an outgoing edge", () => {
    const workflow = buildWorkflow({
      entryNodeId: "intake",
      nodes: [
        { id: "intake", kind: "deterministic", config: {} },
        { id: "final", kind: "final_output", config: {} },
      ],
      edges: [
        { sourceNodeId: "intake", targetNodeId: "final" },
        { sourceNodeId: "final", targetNodeId: "intake" },
      ],
    });
    const diagnostics = validateWorkflowSemantics(workflow);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "FINAL_OUTPUT_HAS_OUTGOING_EDGE", nodeId: "final" }),
    );
  });

  it("rejects a non-final node with zero outgoing edges", () => {
    const workflow = buildWorkflow({
      entryNodeId: "intake",
      nodes: [
        { id: "intake", kind: "deterministic", config: {} },
        { id: "dead-end", kind: "deterministic", config: {} },
      ],
      edges: [{ sourceNodeId: "intake", targetNodeId: "dead-end" }],
    });
    const diagnostics = validateWorkflowSemantics(workflow);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "NON_FINAL_TERMINAL_NODE", nodeId: "dead-end" }),
    );
  });

  it("accepts a workflow with an explicit valid terminal output", () => {
    const workflow = buildWorkflow({
      entryNodeId: "intake",
      nodes: [
        { id: "intake", kind: "deterministic", config: {} },
        { id: "middle", kind: "deterministic", config: {} },
        { id: "final", kind: "final_output", config: {} },
      ],
      edges: [
        { sourceNodeId: "intake", targetNodeId: "middle" },
        { sourceNodeId: "middle", targetNodeId: "final" },
      ],
    });
    expect(validateWorkflowSemantics(workflow)).toEqual([]);
  });

  it("accepts a minimal one-node final_output workflow", () => {
    const workflow = buildWorkflow({
      entryNodeId: "final",
      nodes: [{ id: "final", kind: "final_output", config: {} }],
      edges: [],
    });
    expect(validateWorkflowSemantics(workflow)).toEqual([]);
  });
});
