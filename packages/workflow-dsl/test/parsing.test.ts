import { describe, expect, it } from "vitest";
import { parseWorkflowSource } from "../src/parser.js";

const minimalYaml = `
schemaVersion: 1
id: examples.minimal
version: "1.0.0"
name: Minimal workflow
entryNodeId: intake
nodes:
  - id: intake
    kind: deterministic
    config: {}
  - id: final
    kind: final_output
    config: {}
edges:
  - sourceNodeId: intake
    targetNodeId: final
`;

const minimalJson = JSON.stringify({
  schemaVersion: 1,
  id: "examples.minimal",
  version: "1.0.0",
  name: "Minimal workflow",
  entryNodeId: "intake",
  nodes: [
    { id: "intake", kind: "deterministic", config: {} },
    { id: "final", kind: "final_output", config: {} },
  ],
  edges: [{ sourceNodeId: "intake", targetNodeId: "final" }],
});

describe("parseWorkflowSource", () => {
  it("parses valid YAML into a canonical Workflow", () => {
    const result = parseWorkflowSource(minimalYaml, "yaml");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.id).toBe("examples.minimal");
    expect(result.workflow.nodes).toHaveLength(2);
  });

  it("parses valid JSON into a canonical Workflow", () => {
    const result = parseWorkflowSource(minimalJson, "json");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.id).toBe("examples.minimal");
  });

  it("produces equivalent Workflow objects from equivalent YAML and JSON", () => {
    const yamlResult = parseWorkflowSource(minimalYaml, "yaml");
    const jsonResult = parseWorkflowSource(minimalJson, "json");
    expect(yamlResult.ok).toBe(true);
    expect(jsonResult.ok).toBe(true);
    if (!yamlResult.ok || !jsonResult.ok) return;
    expect(yamlResult.workflow).toEqual(jsonResult.workflow);
  });

  it("returns a normalized PARSE_ERROR diagnostic for malformed YAML, never throws", () => {
    const malformed = "id: [unterminated";
    expect(() => parseWorkflowSource(malformed, "yaml")).not.toThrow();
    const result = parseWorkflowSource(malformed, "yaml");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("PARSE_ERROR");
  });

  it("returns a normalized PARSE_ERROR diagnostic for malformed JSON, never throws raw SyntaxError", () => {
    const malformed = "{ this is not json";
    expect(() => parseWorkflowSource(malformed, "json")).not.toThrow();
    const result = parseWorkflowSource(malformed, "json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("PARSE_ERROR");
  });

  it("rejects unknown top-level fields through the canonical Workflow schema", () => {
    const withUnknownField = JSON.stringify({
      schemaVersion: 1,
      id: "examples.minimal",
      version: "1.0.0",
      name: "Minimal workflow",
      entryNodeId: "intake",
      nodes: [{ id: "intake", kind: "final_output", config: {} }],
      edges: [],
      notARealField: true,
    });
    const result = parseWorkflowSource(withUnknownField, "json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "SCHEMA_VALIDATION_ERROR")).toBe(true);
  });

  it("fails clearly on an unsupported schema version", () => {
    const wrongVersion = JSON.stringify({
      schemaVersion: 2,
      id: "examples.minimal",
      version: "1.0.0",
      name: "Minimal workflow",
      entryNodeId: "intake",
      nodes: [{ id: "intake", kind: "final_output", config: {} }],
      edges: [],
    });
    const result = parseWorkflowSource(wrongVersion, "json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]?.code).toBe("SCHEMA_VALIDATION_ERROR");
    expect(result.diagnostics[0]?.path).toBe("schemaVersion");
  });

  it("enriches a schema diagnostic on a node field with the offending nodeId", () => {
    const badNodeKind = JSON.stringify({
      schemaVersion: 1,
      id: "examples.minimal",
      version: "1.0.0",
      name: "Minimal workflow",
      entryNodeId: "intake",
      nodes: [{ id: "intake", kind: "not_a_real_kind", config: {} }],
      edges: [],
    });
    const result = parseWorkflowSource(badNodeKind, "json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const diagnostic = result.diagnostics.find((d) => d.path === "nodes.0.kind");
    expect(diagnostic?.nodeId).toBe("intake");
  });
});
