import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileWorkflowSource } from "../src/compiler.js";

const here = dirname(fileURLToPath(import.meta.url));
const examplesDir = join(here, "..", "examples", "workflows");
const exampleFiles = readdirSync(examplesDir).filter((file) => file.endsWith(".yaml"));

describe("example workflows", () => {
  it("finds the expected example files", () => {
    expect(exampleFiles.sort()).toEqual(["conditional-routing.yaml", "governed-operational-request.yaml", "minimal.yaml"]);
  });

  it.each(exampleFiles.map((file) => [file]))("%s compiles successfully", (file) => {
    const source = readFileSync(join(examplesDir, file), "utf8");
    const result = compileWorkflowSource(source, "yaml");
    expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
  });

  it("conditional-routing.yaml compiles into a plan with a default route", () => {
    const source = readFileSync(join(examplesDir, "conditional-routing.yaml"), "utf8");
    const result = compileWorkflowSource(source, "yaml");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const intakeOutgoing = result.plan.outgoingEdgesByNode.intake ?? [];
    expect(intakeOutgoing.filter((edge) => edge.condition === undefined)).toHaveLength(1);
    expect(intakeOutgoing.filter((edge) => edge.condition !== undefined)).toHaveLength(2);
  });

  it("governed-operational-request.yaml ends in an explicit final_output after approval", () => {
    const source = readFileSync(join(examplesDir, "governed-operational-request.yaml"), "utf8");
    const result = compileWorkflowSource(source, "yaml");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.terminalNodeIds).toEqual(["final"]);
    expect(result.plan.incomingEdgesByNode.final?.[0]?.sourceNodeId).toBe("require-approval");
  });
});
