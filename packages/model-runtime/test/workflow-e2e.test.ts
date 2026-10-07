import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { compileWorkflowSource } from "@aao/workflow-dsl";
import { RuntimeExecutionSnapshotSchema, createNodeRegistry, executeWorkflow, finalOutputExecutor, validateSnapshotAgainstPlan } from "@aao/runtime";
import { createVercelAiModelAdapter } from "../src/adapters/vercel-ai.js";
import { createModelNodeExecutor } from "../src/model-node.js";
import { TEXT_AND_STRUCTURED, TEXT_ONLY, buildRegistries, buildStructuredRequest, buildTextRequest } from "./fixtures.js";

const WORKFLOW_YAML = `
schemaVersion: 1
id: examples.model-answer
version: "1.0.0"
name: Single model invocation
entryNodeId: answer
nodes:
  - id: answer
    kind: model
    config:
      modelPolicyRef: policy.default
      requestStateKey: modelRequest
      resultStateKey: modelResult
  - id: final
    kind: final_output
    config: {}
edges:
  - sourceNodeId: answer
    targetNodeId: final
`;

const SECRET = "sk-live-SECRET https://api.example.com/v1?key=abc";

function compile() {
  const compiled = compileWorkflowSource(WORKFLOW_YAML, "yaml");
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  return compiled.plan;
}

function mockModel(doGenerate: ConstructorParameters<typeof MockLanguageModelV3>[0] extends infer O ? (O extends { doGenerate?: infer G } ? G : never) : never) {
  return new MockLanguageModelV3({ doGenerate });
}

function textResponse(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: { inputTokens: { total: 9, noCache: 9, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } },
    warnings: [],
  };
}

function testClock() {
  let calls = 0;
  return { now: () => new Date(Date.UTC(2026, 8, 24, 10, 0, calls++)).toISOString() };
}

/** Two compatible text bindings (so "exactly one invoked" and "no fallback" are observable) plus one structured binding. */
function buildWorld(models: { fast: MockLanguageModelV3; backup: MockLanguageModelV3; structured: MockLanguageModelV3 }) {
  const deps = buildRegistries([
    { id: "local.fast", priority: 20, capabilities: TEXT_ONLY, adapter: createVercelAiModelAdapter({ model: models.fast }) },
    { id: "local.backup", priority: 5, capabilities: TEXT_ONLY, adapter: createVercelAiModelAdapter({ model: models.backup }) },
    { id: "local.structured", priority: 10, capabilities: TEXT_AND_STRUCTURED, adapter: createVercelAiModelAdapter({ model: models.structured }) },
  ]);
  const registry = createNodeRegistry();
  registry.register(createModelNodeExecutor(deps));
  registry.register(finalOutputExecutor);
  return registry;
}

describe("AI workflow E2E: YAML → compiler → managed Runtime → model node → router → AI SDK test model", () => {
  it("text: COMPLETED with the ModelResult in state and a valid snapshot", async () => {
    const models = { fast: mockModel(textResponse("AAO is a governed workflow platform.")), backup: mockModel(textResponse("backup")), structured: mockModel(textResponse("{}")) };
    const plan = compile();
    const result = await executeWorkflow({
      runId: "run.e2e.text",
      plan,
      initialState: { runId: "run.e2e.text", revision: 0, values: { modelRequest: buildTextRequest() } },
      registry: buildWorld(models),
      options: { clock: testClock() },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(models.fast.doGenerateCalls).toHaveLength(1);
    expect(models.backup.doGenerateCalls).toHaveLength(0);
    expect(models.structured.doGenerateCalls).toHaveLength(0);
    expect(result.execution.run.status).toBe("COMPLETED");
    expect(result.execution.nodeStatusesById).toEqual({ answer: "SUCCEEDED", final: "SUCCEEDED" });
    expect(result.execution.state.revision).toBe(1);
    const modelResult = {
      schemaVersion: 1,
      invocationId: "inv.text.1",
      modelBindingId: "local.fast",
      outputKind: "text",
      output: "AAO is a governed workflow platform.",
      finishReason: "stop",
      usage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 },
    };
    expect(result.execution.state.values.modelResult).toEqual(modelResult);
    expect(result.output).toEqual({ modelRequest: buildTextRequest(), modelResult });
    expect(validateSnapshotAgainstPlan(result.latestSnapshot, plan)).toBeUndefined();
    expect(result.latestSnapshot.stateSnapshot.values.modelResult).toEqual(modelResult);
  });

  it("structured: the schema-validated object survives adapter → ModelResult → state → snapshot → JSON", async () => {
    const models = { fast: mockModel(textResponse("unused")), backup: mockModel(textResponse("unused")), structured: mockModel(textResponse(JSON.stringify({ category: "research" }))) };
    const plan = compile();
    const result = await executeWorkflow({
      runId: "run.e2e.structured",
      plan,
      initialState: { runId: "run.e2e.structured", revision: 0, values: { modelRequest: buildStructuredRequest() } },
      registry: buildWorld(models),
      options: { clock: testClock() },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(models.structured.doGenerateCalls).toHaveLength(1);
    expect(models.fast.doGenerateCalls).toHaveLength(0);
    expect(result.execution.state.values.modelResult).toMatchObject({ modelBindingId: "local.structured", outputKind: "structured", output: { category: "research" } });

    const serialized = JSON.parse(JSON.stringify(result.latestSnapshot)) as unknown;
    const reparsed = RuntimeExecutionSnapshotSchema.parse(serialized);
    expect(reparsed).toEqual(result.latestSnapshot);
    expect((reparsed.stateSnapshot.values.modelResult as { output: unknown }).output).toEqual({ category: "research" });
    expect(validateSnapshotAgainstPlan(serialized, plan)).toBeUndefined();
  });

  it("failure: selected model fails → node FAILED, Run FAILED, no fallback, state intact, redacted", async () => {
    const models = {
      fast: mockModel(() => {
        throw new Error(SECRET);
      }),
      backup: mockModel(textResponse("backup would have answered")),
      structured: mockModel(textResponse("{}")),
    };
    const plan = compile();
    const initialState = { runId: "run.e2e.fail", revision: 0, values: { modelRequest: buildTextRequest() } };
    const result = await executeWorkflow({ runId: "run.e2e.fail", plan, initialState, registry: buildWorld(models), options: { clock: testClock() } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(models.fast.doGenerateCalls).toHaveLength(1);
    expect(models.backup.doGenerateCalls).toHaveLength(0);
    expect(models.structured.doGenerateCalls).toHaveLength(0);
    expect(result.failure).toEqual({
      code: "NODE_EXECUTION_FAILED",
      message: 'Node "answer" (kind "model") reported an executor failure.',
      nodeId: "answer",
      step: 1,
      executorFailure: { namespace: "model", code: "MODEL_INVOCATION_FAILED" },
      category: "EXECUTION", retryable: false, attempt: 1, maxAttempts: 1,
    });
    expect(result.execution?.run.status).toBe("FAILED");
    expect(result.execution?.nodeStatusesById).toEqual({ answer: "FAILED", final: "PENDING" });
    expect(result.execution?.state).toEqual(initialState);
    expect(result.latestSnapshot?.stateSnapshot.revision).toBe(0);
    expect(validateSnapshotAgainstPlan(result.latestSnapshot, plan)).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/SECRET|example\.com/);
  });
});
