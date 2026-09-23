import { describe, expect, it } from "vitest";
import { validateWorkflowSemantics } from "../src/semantic-validator.js";
import { buildWorkflow, minimalValidWorkflow } from "./fixtures.js";

describe("validateWorkflowSemantics — graph integrity", () => {
  it("accepts a valid minimal workflow with no diagnostics", () => {
    expect(validateWorkflowSemantics(minimalValidWorkflow)).toEqual([]);
  });

  it("accepts valid acyclic branching (entry, two branches, shared final)", () => {
    const workflow = buildWorkflow({
      entryNodeId: "intake",
      nodes: [
        { id: "intake", kind: "deterministic", config: {} },
        { id: "branch-a", kind: "deterministic", config: {} },
        { id: "branch-b", kind: "deterministic", config: {} },
        { id: "final", kind: "final_output", config: {} },
      ],
      edges: [
        { sourceNodeId: "intake", targetNodeId: "branch-a", condition: { when: "a" } },
        { sourceNodeId: "intake", targetNodeId: "branch-b" },
        { sourceNodeId: "branch-a", targetNodeId: "final" },
        { sourceNodeId: "branch-b", targetNodeId: "final" },
      ],
    });
    expect(validateWorkflowSemantics(workflow)).toEqual([]);
  });

  it("rejects a missing entry node", () => {
    const workflow = buildWorkflow({
      entryNodeId: "does-not-exist",
      nodes: [{ id: "final", kind: "final_output", config: {} }],
      edges: [],
    });
    const diagnostics = validateWorkflowSemantics(workflow);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "ENTRY_NODE_NOT_FOUND", path: "entryNodeId" }),
    );
  });

  it("rejects duplicate node ids", () => {
    const workflow = buildWorkflow({
      entryNodeId: "intake",
      nodes: [
        { id: "intake", kind: "deterministic", config: {} },
        { id: "intake", kind: "final_output", config: {} },
      ],
      edges: [],
    });
    const diagnostics = validateWorkflowSemantics(workflow);
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "DUPLICATE_NODE_ID", nodeId: "intake" }));
  });

  it("rejects an edge with a missing source", () => {
    const workflow = buildWorkflow({
      entryNodeId: "intake",
      nodes: [
        { id: "intake", kind: "deterministic", config: {} },
        { id: "final", kind: "final_output", config: {} },
      ],
      edges: [{ sourceNodeId: "ghost", targetNodeId: "final" }],
    });
    const diagnostics = validateWorkflowSemantics(workflow);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "EDGE_SOURCE_NOT_FOUND", edgeIndex: 0 }),
    );
  });

  it("rejects an edge with a missing target", () => {
    const workflow = buildWorkflow({
      entryNodeId: "intake",
      nodes: [
        { id: "intake", kind: "deterministic", config: {} },
        { id: "final", kind: "final_output", config: {} },
      ],
      edges: [{ sourceNodeId: "intake", targetNodeId: "ghost" }],
    });
    const diagnostics = validateWorkflowSemantics(workflow);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "EDGE_TARGET_NOT_FOUND", edgeIndex: 0 }),
    );
  });

  it("rejects an unreachable node", () => {
    const workflow = buildWorkflow({
      entryNodeId: "intake",
      nodes: [
        { id: "intake", kind: "deterministic", config: {} },
        { id: "final", kind: "final_output", config: {} },
        { id: "orphan", kind: "final_output", config: {} },
      ],
      edges: [{ sourceNodeId: "intake", targetNodeId: "final" }],
    });
    const diagnostics = validateWorkflowSemantics(workflow);
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "UNREACHABLE_NODE", nodeId: "orphan" }));
  });

  it("rejects a self-cycle", () => {
    const workflow = buildWorkflow({
      entryNodeId: "intake",
      nodes: [{ id: "intake", kind: "deterministic", config: {} }],
      edges: [{ sourceNodeId: "intake", targetNodeId: "intake" }],
    });
    const diagnostics = validateWorkflowSemantics(workflow);
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "CYCLE_NOT_SUPPORTED" }));
  });

  it("rejects a multi-node cycle", () => {
    const workflow = buildWorkflow({
      entryNodeId: "a",
      nodes: [
        { id: "a", kind: "deterministic", config: {} },
        { id: "b", kind: "deterministic", config: {} },
        { id: "c", kind: "deterministic", config: {} },
      ],
      edges: [
        { sourceNodeId: "a", targetNodeId: "b" },
        { sourceNodeId: "b", targetNodeId: "c" },
        { sourceNodeId: "c", targetNodeId: "a" },
      ],
    });
    const diagnostics = validateWorkflowSemantics(workflow);
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "CYCLE_NOT_SUPPORTED" }));
  });

  it("collects multiple independent graph errors in one pass instead of stopping at the first", () => {
    const workflow = buildWorkflow({
      entryNodeId: "does-not-exist",
      nodes: [
        { id: "reachable", kind: "final_output", config: {} },
        { id: "orphan", kind: "final_output", config: {} },
      ],
      edges: [{ sourceNodeId: "ghost", targetNodeId: "reachable" }],
    });
    const diagnostics = validateWorkflowSemantics(workflow);
    const codes = diagnostics.map((d) => d.code);
    expect(codes).toContain("ENTRY_NODE_NOT_FOUND");
    expect(codes).toContain("EDGE_SOURCE_NOT_FOUND");
    // Reachability is skipped entirely when the entry node itself is missing
    // (there is no starting point to traverse from), so no UNREACHABLE_NODE
    // diagnostics cascade from the missing entry.
    expect(codes).not.toContain("UNREACHABLE_NODE");
  });

  it("collects a broken edge target and an unreachable node together when the entry node is valid", () => {
    const workflow = buildWorkflow({
      entryNodeId: "intake",
      nodes: [
        { id: "intake", kind: "deterministic", config: {} },
        { id: "final", kind: "final_output", config: {} },
        { id: "orphan", kind: "final_output", config: {} },
      ],
      edges: [
        { sourceNodeId: "intake", targetNodeId: "final" },
        { sourceNodeId: "intake", targetNodeId: "ghost" },
      ],
    });
    const diagnostics = validateWorkflowSemantics(workflow);
    const codes = diagnostics.map((d) => d.code);
    expect(codes).toContain("EDGE_TARGET_NOT_FOUND");
    expect(codes).toContain("UNREACHABLE_NODE");
  });

  it("handles a reasonably large linear graph without recursion errors", () => {
    const size = 2000;
    const nodes = Array.from({ length: size }, (_, i) => ({
      id: `n${i}`,
      kind: i === size - 1 ? ("final_output" as const) : ("deterministic" as const),
      config: {},
    }));
    const edges = Array.from({ length: size - 1 }, (_, i) => ({
      sourceNodeId: `n${i}`,
      targetNodeId: `n${i + 1}`,
    }));
    const workflow = buildWorkflow({ entryNodeId: "n0", nodes, edges });
    expect(() => validateWorkflowSemantics(workflow)).not.toThrow();
    expect(validateWorkflowSemantics(workflow)).toEqual([]);
  });
});
