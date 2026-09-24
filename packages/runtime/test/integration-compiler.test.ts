import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { compileWorkflowSource, parseWorkflowSource } from "@aao/workflow-dsl";
import { executeWorkflow } from "../src/engine.js";
import { createRuntimeV1Registry } from "../src/default-registry.js";
import { createNodeRegistry } from "../src/registry.js";
import { buildRunState, literalPatchExecutor } from "./fixtures.js";
import type { NodeExecutor } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeExamplesDir = join(here, "..", "examples", "workflows");
const workflowDslExamplesDir = join(here, "..", "..", "workflow-dsl", "examples", "workflows");

/**
 * The first real, cross-package AAO execution path: YAML source ->
 * @aao/workflow-dsl's actual parse/compile pipeline -> @aao/runtime's actual
 * engine -> custom deterministic executors -> final_output -> expected
 * state/result. No fake compiled plan — this uses the production packages
 * end to end, entirely locally and deterministically.
 */
describe("compiler -> runtime integration", () => {
  it("executes the deterministic-demo example end to end and produces the documented result", async () => {
    const source = readFileSync(join(runtimeExamplesDir, "deterministic-demo.yaml"), "utf8");
    const compiled = compileWorkflowSource(source, "yaml");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const registry = createRuntimeV1Registry();
    registry.register(literalPatchExecutor);

    const result = await executeWorkflow({
      runId: "run.integration.demo",
      plan: compiled.plan,
      initialState: buildRunState("run.integration.demo", { value: 2 }),
      registry,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe("COMPLETED");
    expect(result.run.state.values).toEqual({ value: 4, result: 8 });
    expect(result.run.output).toEqual({ value: 4, result: 8 });
  });

  it("rejects examples/workflows/conditional-routing.yaml (@aao/workflow-dsl) at Runtime preflight with zero node executors invoked", async () => {
    const source = readFileSync(join(workflowDslExamplesDir, "conditional-routing.yaml"), "utf8");
    const compiled = compileWorkflowSource(source, "yaml");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const executeSpy = vi.fn(async () => ({}));
    const deterministicExecutor: NodeExecutor = { kind: "deterministic", execute: executeSpy };
    const registry = createRuntimeV1Registry(); // already has final_output
    registry.register(deterministicExecutor);

    const result = await executeWorkflow({
      runId: "run.integration.conditional",
      plan: compiled.plan,
      initialState: buildRunState("run.integration.conditional"),
      registry,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("CONDITIONAL_ROUTING_UNSUPPORTED");
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("rejects examples/workflows/governed-operational-request.yaml (@aao/workflow-dsl) because model/tool/approval executors are not registered", async () => {
    const source = readFileSync(join(workflowDslExamplesDir, "governed-operational-request.yaml"), "utf8");
    const compiled = compileWorkflowSource(source, "yaml");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    // Only deterministic + final_output are registered — model/tool/approval are absent on purpose.
    const registry = createNodeRegistry();
    registry.register(literalPatchExecutor);
    registry.register(createRuntimeV1Registry().get("final_output")!);

    const result = await executeWorkflow({
      runId: "run.integration.governed",
      plan: compiled.plan,
      initialState: buildRunState("run.integration.governed"),
      registry,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("NODE_EXECUTOR_NOT_FOUND");
    // "reason" (kind "model") is the first unsupported node encountered.
    expect(result.failure.nodeId).toBe("reason");
  });

  it("proves an invalid workflow source never reaches the Runtime: compiler failure stops the pipeline before execution", () => {
    const invalidSource = "id: not-a-full-workflow\n"; // missing required fields
    const parsed = parseWorkflowSource(invalidSource, "yaml");
    expect(parsed.ok).toBe(false);

    const compiled = compileWorkflowSource(invalidSource, "yaml");
    expect(compiled.ok).toBe(false);
    // No CompiledWorkflowPlan is ever produced for invalid source, so there
    // is nothing a caller could pass to executeWorkflow in the first place —
    // the untrusted-definition -> validation -> trusted-plan -> runtime
    // boundary has no bypass.
  });
});
