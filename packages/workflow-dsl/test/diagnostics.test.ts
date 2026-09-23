import { describe, expect, it } from "vitest";
import { WORKFLOW_DIAGNOSTIC_CODES } from "../src/diagnostics.js";
import { compileWorkflowSource } from "../src/compiler.js";
import { validateWorkflowSemantics } from "../src/semantic-validator.js";
import { buildWorkflow } from "./fixtures.js";

describe("diagnostic quality", () => {
  it("exposes a documented, stable code list", () => {
    expect(WORKFLOW_DIAGNOSTIC_CODES).toEqual([
      "PARSE_ERROR",
      "SCHEMA_VALIDATION_ERROR",
      "DUPLICATE_NODE_ID",
      "ENTRY_NODE_NOT_FOUND",
      "EDGE_SOURCE_NOT_FOUND",
      "EDGE_TARGET_NOT_FOUND",
      "DUPLICATE_EDGE",
      "UNREACHABLE_NODE",
      "CYCLE_NOT_SUPPORTED",
      "FINAL_OUTPUT_HAS_OUTGOING_EDGE",
      "NON_FINAL_TERMINAL_NODE",
      "AMBIGUOUS_ROUTING",
      "CONDITIONAL_ROUTE_WITHOUT_DEFAULT",
    ]);
  });

  it("returns diagnostics in a stable, deterministic order across repeated runs", () => {
    const workflow = buildWorkflow({
      entryNodeId: "missing-entry",
      nodes: [
        { id: "dup", kind: "deterministic", config: {} },
        { id: "dup", kind: "final_output", config: {} },
      ],
      edges: [
        { sourceNodeId: "ghost-source", targetNodeId: "dup" },
        { sourceNodeId: "dup", targetNodeId: "ghost-target" },
      ],
    });

    const first = validateWorkflowSemantics(workflow).map((d) => d.code);
    const second = validateWorkflowSemantics(workflow).map((d) => d.code);
    expect(first).toEqual(second);
    expect(first).toEqual([
      "DUPLICATE_NODE_ID",
      "ENTRY_NODE_NOT_FOUND",
      "EDGE_SOURCE_NOT_FOUND",
      "EDGE_TARGET_NOT_FOUND",
      // "dup" (the first, kept occurrence) ends up with zero valid outgoing
      // edges once both edges are excluded for missing endpoints, and it is
      // not a final_output node.
      "NON_FINAL_TERMINAL_NODE",
    ]);
  });

  it("identifies the relevant node for node-anchored diagnostics", () => {
    const workflow = buildWorkflow({
      entryNodeId: "intake",
      nodes: [
        { id: "intake", kind: "deterministic", config: {} },
        { id: "dead-end", kind: "deterministic", config: {} },
      ],
      edges: [{ sourceNodeId: "intake", targetNodeId: "dead-end" }],
    });
    const diagnostics = validateWorkflowSemantics(workflow);
    const diagnostic = diagnostics.find((d) => d.code === "NON_FINAL_TERMINAL_NODE");
    expect(diagnostic?.nodeId).toBe("dead-end");
  });

  it("identifies the relevant edge index for edge-anchored diagnostics", () => {
    const workflow = buildWorkflow({
      entryNodeId: "intake",
      nodes: [{ id: "intake", kind: "deterministic", config: {} }],
      edges: [{ sourceNodeId: "intake", targetNodeId: "ghost" }],
    });
    const diagnostics = validateWorkflowSemantics(workflow);
    expect(diagnostics[0]?.edgeIndex).toBe(0);
  });

  it("does not expose a raw parser stack trace or Error object as a diagnostic message", () => {
    const result = compileWorkflowSource("not: [valid", "yaml");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const diagnostic of result.diagnostics) {
      expect(typeof diagnostic.message).toBe("string");
      expect(diagnostic.message).not.toContain("at Object.");
      expect(diagnostic.message).not.toContain(".ts:");
      expect(diagnostic.message).not.toContain("node_modules");
    }
  });

  it("does not leak environment variables into diagnostic messages", () => {
    const originalSecret = process.env.AAO_TEST_SECRET;
    process.env.AAO_TEST_SECRET = "super-secret-value";
    try {
      const result = compileWorkflowSource("{ broken", "json");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        for (const diagnostic of result.diagnostics) {
          expect(diagnostic.message).not.toContain("super-secret-value");
        }
      }
    } finally {
      if (originalSecret === undefined) delete process.env.AAO_TEST_SECRET;
      else process.env.AAO_TEST_SECRET = originalSecret;
    }
  });

  it("every diagnostic is JSON-safe", () => {
    const workflow = buildWorkflow({
      entryNodeId: "missing",
      nodes: [{ id: "final", kind: "final_output", config: {} }],
      edges: [],
    });
    const diagnostics = validateWorkflowSemantics(workflow);
    expect(() => JSON.parse(JSON.stringify(diagnostics))).not.toThrow();
    expect(JSON.parse(JSON.stringify(diagnostics))).toEqual(diagnostics);
  });
});
