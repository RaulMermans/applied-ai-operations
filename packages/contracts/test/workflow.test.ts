import { describe, expect, it } from "vitest";
import { EdgeDefinitionSchema, NodeDefinitionSchema, NodeKindSchema, WorkflowSchema } from "../src/workflow.js";
import { governedOperationalWorkflowFixture, minimalWorkflowFixture } from "./fixtures.js";

const CANONICAL_NODE_KINDS = ["deterministic", "model", "agent", "tool", "approval", "evaluator", "final_output"] as const;

describe("NodeKindSchema", () => {
  it.each(CANONICAL_NODE_KINDS.map((kind) => [kind]))("accepts canonical node kind %s", (kind) => {
    expect(NodeKindSchema.safeParse(kind).success).toBe(true);
  });

  it("rejects a speculative node kind", () => {
    expect(NodeKindSchema.safeParse("webhook").success).toBe(false);
  });
});

describe("NodeDefinitionSchema", () => {
  it("parses a valid node with opaque config", () => {
    const result = NodeDefinitionSchema.safeParse({ id: "n1", kind: "deterministic", config: { anything: "goes" } });
    expect(result.success).toBe(true);
  });

  it("rejects a node missing a required field", () => {
    expect(NodeDefinitionSchema.safeParse({ id: "n1", config: {} }).success).toBe(false);
  });

  it("rejects a node with an invalid kind", () => {
    expect(NodeDefinitionSchema.safeParse({ id: "n1", kind: "not-a-kind", config: {} }).success).toBe(false);
  });

  it("rejects a node with a non-JSON-safe config", () => {
    expect(NodeDefinitionSchema.safeParse({ id: "n1", kind: "deterministic", config: { fn: () => 1 } }).success).toBe(false);
  });
});

describe("EdgeDefinitionSchema", () => {
  it("parses a valid edge without a condition", () => {
    expect(EdgeDefinitionSchema.safeParse({ sourceNodeId: "a", targetNodeId: "b" }).success).toBe(true);
  });

  it("parses a valid edge with an opaque condition", () => {
    expect(
      EdgeDefinitionSchema.safeParse({ sourceNodeId: "a", targetNodeId: "b", condition: { op: "eq", value: 1 } }).success,
    ).toBe(true);
  });

  it("rejects an edge missing a required field", () => {
    expect(EdgeDefinitionSchema.safeParse({ sourceNodeId: "a" }).success).toBe(false);
  });
});

describe("WorkflowSchema", () => {
  it("parses the minimal workflow fixture", () => {
    expect(WorkflowSchema.safeParse(minimalWorkflowFixture).success).toBe(true);
  });

  it("parses the governed operational workflow fixture", () => {
    expect(WorkflowSchema.safeParse(governedOperationalWorkflowFixture).success).toBe(true);
  });

  it("rejects a workflow missing required fields", () => {
    const { entryNodeId: _entryNodeId, ...malformed } = minimalWorkflowFixture;
    expect(WorkflowSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects a workflow with a malformed node", () => {
    const malformed = {
      ...minimalWorkflowFixture,
      nodes: [{ id: "bad-node" }],
    };
    expect(WorkflowSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects a workflow with a malformed edge", () => {
    const malformed = {
      ...minimalWorkflowFixture,
      edges: [{ sourceNodeId: "intake" }],
    };
    expect(WorkflowSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects a workflow with an empty nodes array", () => {
    expect(WorkflowSchema.safeParse({ ...minimalWorkflowFixture, nodes: [] }).success).toBe(false);
  });

  it("rejects an unexpected top-level field", () => {
    expect(WorkflowSchema.safeParse({ ...minimalWorkflowFixture, unexpected: true }).success).toBe(false);
  });

  it("does not validate graph semantics such as entryNodeId referring to an existing node", () => {
    // Deliberate non-goal for this sprint: reachability/cycle/entry validation
    // belongs to the future Workflow DSL/compiler, not the domain contract.
    const notReferencingRealNode = { ...minimalWorkflowFixture, entryNodeId: "does-not-exist" };
    expect(WorkflowSchema.safeParse(notReferencingRealNode).success).toBe(true);
  });
});
