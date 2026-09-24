import { describe, expect, it } from "vitest";
import type { NodeDefinition } from "@aao/contracts";
import { finalOutputExecutor } from "../src/default-registry.js";
import { executeWorkflow } from "../src/engine.js";
import { runPreflight } from "../src/preflight.js";
import type { NodeExecutor, NodePreflightResult } from "../src/types.js";
import { buildRequest, buildTestClock, buildWorkflow, compileOrThrow, createTestRegistry } from "./fixtures.js";

/** deterministic -> checked (an executor with a validateConfig hook) -> final */
const plan = compileOrThrow(
  buildWorkflow({
    entryNodeId: "first",
    nodes: [
      { id: "first", kind: "deterministic", config: {} },
      { id: "checked", kind: "evaluator", config: { threshold: 3 } },
      { id: "final", kind: "final_output", config: {} },
    ],
    edges: [
      { sourceNodeId: "first", targetNodeId: "checked" },
      { sourceNodeId: "checked", targetNodeId: "final" },
    ],
  }),
);

function spyExecutor(kind: NodeExecutor["kind"], validateConfig?: (node: NodeDefinition) => NodePreflightResult) {
  const calls: string[] = [];
  const validated: string[] = [];
  const executor: NodeExecutor = {
    kind,
    ...(validateConfig !== undefined
      ? {
          validateConfig: ({ node }) => {
            validated.push(node.id);
            return validateConfig(node);
          },
        }
      : {}),
    async execute(context) {
      calls.push(context.node.id);
      return {};
    },
  };
  return { executor, calls, validated };
}

describe("Runtime preflight: node-specific static config validation", () => {
  it("passes when the hook accepts the config, and executes normally", async () => {
    const first = spyExecutor("deterministic");
    const checked = spyExecutor("evaluator", () => ({ ok: true }));
    const registry = createTestRegistry(first.executor, checked.executor, finalOutputExecutor);
    const result = await executeWorkflow(buildRequest({ runId: "run.cfg.ok", plan, registry, options: { clock: buildTestClock() } }));
    expect(result.ok).toBe(true);
    expect(checked.validated).toEqual(["checked"]);
    expect([...first.calls, ...checked.calls]).toEqual(["first", "checked"]);
  });

  it("fails with RUNTIME_PREFLIGHT_FAILED and executes zero nodes when a later node's config is invalid", async () => {
    const first = spyExecutor("deterministic");
    const checked = spyExecutor("evaluator", () => ({ ok: false, issues: ["threshold must be a string"] }));
    const registry = createTestRegistry(first.executor, checked.executor, finalOutputExecutor);
    const result = await executeWorkflow(buildRequest({ runId: "run.cfg.bad", plan, registry, options: { clock: buildTestClock() } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({
      code: "RUNTIME_PREFLIGHT_FAILED",
      message: 'Node "checked" (kind "evaluator") has invalid static configuration.',
      nodeId: "checked",
      details: { issues: ["threshold must be a string"] },
    });
    expect(first.calls).toEqual([]);
    expect(checked.calls).toEqual([]);
    expect(result.execution?.run.status).toBe("FAILED");
    expect(Object.values(result.execution?.nodeStatusesById ?? {})).toEqual(["PENDING", "PENDING", "PENDING"]);
    expect(result.execution?.state.revision).toBe(0);
  });

  it("treats a throwing hook as a failed validation without exposing the thrown value", () => {
    const checked = spyExecutor("evaluator", () => {
      throw new Error("secret-token-xyz");
    });
    const failure = runPreflight(plan, createTestRegistry(spyExecutor("deterministic").executor, checked.executor, finalOutputExecutor));
    expect(failure?.code).toBe("RUNTIME_PREFLIGHT_FAILED");
    expect(JSON.stringify(failure)).not.toContain("secret-token-xyz");
    expect(failure?.details).toBeUndefined();
  });

  it("hands the hook a clone, so it cannot mutate the plan", () => {
    const checked = spyExecutor("evaluator", (node) => {
      (node.config as Record<string, unknown>).threshold = 999;
      return { ok: true };
    });
    runPreflight(plan, createTestRegistry(spyExecutor("deterministic").executor, checked.executor, finalOutputExecutor));
    expect(plan.nodesById.checked?.config).toEqual({ threshold: 3 });
  });

  it("does not call the hook for plans that fail an earlier preflight check (missing executor)", () => {
    const checked = spyExecutor("evaluator", () => ({ ok: true }));
    const failure = runPreflight(plan, createTestRegistry(checked.executor, finalOutputExecutor));
    expect(failure?.code).toBe("NODE_EXECUTOR_NOT_FOUND");
    expect(checked.validated).toEqual([]);
  });
});
