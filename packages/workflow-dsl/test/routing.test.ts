import { describe, expect, it } from "vitest";
import { validateWorkflowSemantics } from "../src/semantic-validator.js";
import { buildWorkflow } from "./fixtures.js";

describe("validateWorkflowSemantics — routing", () => {
  it("accepts a single unconditional edge (simple route)", () => {
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

  it("accepts conditional edges plus exactly one default edge", () => {
    const workflow = buildWorkflow({
      entryNodeId: "intake",
      nodes: [
        { id: "intake", kind: "deterministic", config: {} },
        { id: "a", kind: "final_output", config: {} },
        { id: "b", kind: "final_output", config: {} },
        { id: "default", kind: "final_output", config: {} },
      ],
      edges: [
        { sourceNodeId: "intake", targetNodeId: "a", condition: { when: "a" } },
        { sourceNodeId: "intake", targetNodeId: "b", condition: { when: "b" } },
        { sourceNodeId: "intake", targetNodeId: "default" },
      ],
    });
    expect(validateWorkflowSemantics(workflow)).toEqual([]);
  });

  it("rejects two unconditional outgoing edges as ambiguous routing", () => {
    const workflow = buildWorkflow({
      entryNodeId: "intake",
      nodes: [
        { id: "intake", kind: "deterministic", config: {} },
        { id: "a", kind: "final_output", config: {} },
        { id: "b", kind: "final_output", config: {} },
      ],
      edges: [
        { sourceNodeId: "intake", targetNodeId: "a" },
        { sourceNodeId: "intake", targetNodeId: "b" },
      ],
    });
    const diagnostics = validateWorkflowSemantics(workflow);
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "AMBIGUOUS_ROUTING", nodeId: "intake" }));
  });

  it("rejects a single conditional outgoing edge with no default route", () => {
    const workflow = buildWorkflow({
      entryNodeId: "intake",
      nodes: [
        { id: "intake", kind: "deterministic", config: {} },
        { id: "a", kind: "final_output", config: {} },
      ],
      edges: [{ sourceNodeId: "intake", targetNodeId: "a", condition: { when: "a" } }],
    });
    const diagnostics = validateWorkflowSemantics(workflow);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "CONDITIONAL_ROUTE_WITHOUT_DEFAULT", nodeId: "intake" }),
    );
    expect(diagnostics.some((d) => d.code === "AMBIGUOUS_ROUTING")).toBe(false);
  });

  it("rejects multiple conditional branches with no default route", () => {
    const workflow = buildWorkflow({
      entryNodeId: "intake",
      nodes: [
        { id: "intake", kind: "deterministic", config: {} },
        { id: "a", kind: "final_output", config: {} },
        { id: "b", kind: "final_output", config: {} },
      ],
      edges: [
        { sourceNodeId: "intake", targetNodeId: "a", condition: { when: "a" } },
        { sourceNodeId: "intake", targetNodeId: "b", condition: { when: "b" } },
      ],
    });
    const diagnostics = validateWorkflowSemantics(workflow);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "CONDITIONAL_ROUTE_WITHOUT_DEFAULT", nodeId: "intake" }),
    );
  });

  it("does not evaluate condition contents — any opaque JSON condition is accepted", () => {
    const workflow = buildWorkflow({
      entryNodeId: "intake",
      nodes: [
        { id: "intake", kind: "deterministic", config: {} },
        { id: "a", kind: "final_output", config: {} },
        { id: "default", kind: "final_output", config: {} },
      ],
      edges: [
        { sourceNodeId: "intake", targetNodeId: "a", condition: { anything: [1, 2, { nested: true }] } },
        { sourceNodeId: "intake", targetNodeId: "default" },
      ],
    });
    expect(validateWorkflowSemantics(workflow)).toEqual([]);
  });

  it("rejects exact duplicate unconditional edges", () => {
    const workflow = buildWorkflow({
      entryNodeId: "intake",
      nodes: [
        { id: "intake", kind: "deterministic", config: {} },
        { id: "final", kind: "final_output", config: {} },
      ],
      edges: [
        { sourceNodeId: "intake", targetNodeId: "final" },
        { sourceNodeId: "intake", targetNodeId: "final" },
      ],
    });
    const diagnostics = validateWorkflowSemantics(workflow);
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "DUPLICATE_EDGE", edgeIndex: 1 }));
  });

  it("allows different conditions from the same source to the same target", () => {
    const workflow = buildWorkflow({
      entryNodeId: "intake",
      nodes: [
        { id: "intake", kind: "deterministic", config: {} },
        { id: "final", kind: "final_output", config: {} },
      ],
      edges: [
        { sourceNodeId: "intake", targetNodeId: "final", condition: { when: "a" } },
        { sourceNodeId: "intake", targetNodeId: "final", condition: { when: "b" } },
      ],
    });
    // Two conditional edges to the same target with no default is still a
    // routing violation, but must NOT also be flagged as a duplicate edge.
    const diagnostics = validateWorkflowSemantics(workflow);
    expect(diagnostics.some((d) => d.code === "DUPLICATE_EDGE")).toBe(false);
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "CONDITIONAL_ROUTE_WITHOUT_DEFAULT" }));
  });

  it("treats conditions that differ only in key order as the same condition for duplicate-edge detection", () => {
    // { a: 1, b: 2 } and { b: 2, a: 1 } must be structurally equivalent here
    // — condition semantics are never evaluated, only canonical JSON shape.
    const workflow = buildWorkflow({
      entryNodeId: "intake",
      nodes: [
        { id: "intake", kind: "deterministic", config: {} },
        { id: "final", kind: "final_output", config: {} },
      ],
      edges: [
        { sourceNodeId: "intake", targetNodeId: "final", condition: { a: 1, b: 2 } },
        { sourceNodeId: "intake", targetNodeId: "final", condition: { b: 2, a: 1 } },
      ],
    });
    const diagnostics = validateWorkflowSemantics(workflow);
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "DUPLICATE_EDGE", edgeIndex: 1 }));
  });
});
