import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileWorkflow, compileWorkflowSource } from "../src/compiler.js";
import { parseWorkflowSource } from "../src/parser.js";
import { buildWorkflow, minimalValidWorkflow } from "./fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const examplesDir = join(here, "..", "examples", "workflows");

describe("compileWorkflow", () => {
  it("compiles a valid Workflow into a plan", () => {
    const result = compileWorkflow(minimalValidWorkflow);
    expect(result.ok).toBe(true);
  });

  it("never returns a plan for an invalid Workflow", () => {
    const invalid = buildWorkflow({
      entryNodeId: "missing",
      nodes: [{ id: "final", kind: "final_output", config: {} }],
      edges: [],
    });
    const result = compileWorkflow(invalid);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("produces the expected nodesById and terminal ids", () => {
    const result = compileWorkflow(minimalValidWorkflow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.plan.nodesById).sort()).toEqual(["final", "intake"]);
    expect(result.plan.terminalNodeIds).toEqual(["final"]);
    expect(result.plan.entryNodeId).toBe("intake");
  });

  it("produces correct outgoing/incoming edge indexes", () => {
    const workflow = buildWorkflow({
      entryNodeId: "a",
      nodes: [
        { id: "a", kind: "deterministic", config: {} },
        { id: "b", kind: "deterministic", config: {} },
        { id: "c", kind: "final_output", config: {} },
      ],
      edges: [
        { sourceNodeId: "a", targetNodeId: "b" },
        { sourceNodeId: "b", targetNodeId: "c" },
      ],
    });
    const result = compileWorkflow(workflow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.outgoingEdgesByNode.a).toHaveLength(1);
    expect(result.plan.outgoingEdgesByNode.a?.[0]?.targetNodeId).toBe("b");
    expect(result.plan.incomingEdgesByNode.c).toHaveLength(1);
    expect(result.plan.incomingEdgesByNode.c?.[0]?.sourceNodeId).toBe("b");
    expect(result.plan.incomingEdgesByNode.a).toHaveLength(0);
    expect(result.plan.outgoingEdgesByNode.c).toHaveLength(0);
  });

  it("does not mutate the caller's original Workflow object", () => {
    const workflow = buildWorkflow({
      entryNodeId: "intake",
      nodes: [
        { id: "intake", kind: "deterministic", config: { note: "original" } },
        { id: "final", kind: "final_output", config: {} },
      ],
      edges: [{ sourceNodeId: "intake", targetNodeId: "final" }],
    });
    const snapshot = JSON.parse(JSON.stringify(workflow));

    const result = compileWorkflow(workflow);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Mutate the returned plan's workflow/index structures and confirm the
      // caller's original object is still untouched afterward.
      result.plan.workflow.name = "mutated";
      result.plan.nodesById.intake!.config.note = "mutated";
      result.plan.outgoingEdgesByNode.intake!.push({ sourceNodeId: "intake", targetNodeId: "final" });
    }

    expect(workflow).toEqual(snapshot);
  });

  it("compiles deterministically: compile(workflow) equals compile(workflow)", () => {
    const first = compileWorkflow(minimalValidWorkflow);
    const second = compileWorkflow(minimalValidWorkflow);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("introduces no timestamp or random value into the compiled plan", () => {
    const result = compileWorkflow(minimalValidWorkflow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.plan);
    // No ISO timestamp shape anywhere in the compiled output.
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("round-trips through JSON.stringify -> JSON.parse without semantic loss", () => {
    const result = compileWorkflow(minimalValidWorkflow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const roundTripped = JSON.parse(JSON.stringify(result.plan));
    expect(roundTripped).toEqual(result.plan);
  });
});

describe("compileWorkflowSource", () => {
  it("compiles equivalent YAML and JSON sources into equivalent plans", () => {
    const yamlSource = readFileSync(join(examplesDir, "minimal.yaml"), "utf8");
    const parsedYaml = parseWorkflowSource(yamlSource, "yaml");
    expect(parsedYaml.ok).toBe(true);
    if (!parsedYaml.ok) return;
    const jsonSource = JSON.stringify(parsedYaml.workflow);

    const fromYaml = compileWorkflowSource(yamlSource, "yaml");
    const fromJson = compileWorkflowSource(jsonSource, "json");
    expect(fromYaml.ok).toBe(true);
    expect(fromJson.ok).toBe(true);
    expect(fromYaml).toEqual(fromJson);
  });

  it("propagates parse diagnostics without compiling", () => {
    const result = compileWorkflowSource("{ not json", "json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]?.code).toBe("PARSE_ERROR");
  });
});
