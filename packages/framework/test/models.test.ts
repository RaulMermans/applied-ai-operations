import { describe, expect, it } from "vitest";
import { createInMemoryTraceStore, createTraceRecorder } from "@aao/observability";
import { AAOFrameworkError, createAAO, defineAdapterManifest, defineModelAdapter, defineTool, type AAOOptions, type DeterministicExecutor, type Workflow } from "../src/index.js";
import { agentDecision, agentWorkflow, binding, classificationPolicy, modelWorkflow, nativeManifest, prepareRequest, scriptedModel, structured, synthesizer } from "./model-support.js";
import { alice, bob, countingTool, governanceInput, mallory } from "./support.js";

/**
 * Sprint 20 (ADR-025): the Framework executes `model`, `agent`, and
 * `deterministic` nodes through the stable adapter contract and the
 * canonical Model Runtime, Agent Runtime, and deterministic executor. It
 * runs no second runtime, loop, or registry of its own.
 */
const clock = () => {
  let tick = 0;
  return { now: () => new Date(Date.UTC(2026, 9, 14, 8, 0, tick++)).toISOString() };
};

function app(overrides: Partial<AAOOptions> = {}, model = scriptedModel([structured({ category: "research" })])) {
  const options: AAOOptions = {
    governance: governanceInput(),
    principalForRun: () => alice,
    modelAdapters: [defineModelAdapter({ manifest: nativeManifest(), adapter: model })],
    modelBindings: [binding()],
    modelPolicies: [classificationPolicy],
    deterministicExecutors: [prepareRequest],
    clock: clock(),
    ...overrides,
  };
  return { app: createAAO(options), model, options };
}

const run = (workflow: Workflow, a = app().app, values: Record<string, string> = { company: "acme" }, runId = "run-m") => a.prepareWorkflow(workflow).execute({ runId, initialState: { runId, revision: 0, values } });
const configurationError = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AAOFrameworkError);
    return error as AAOFrameworkError;
  }
  throw new Error("expected an AAOFrameworkError");
};

describe("Framework model nodes through the public adapter contract", () => {
  it("deterministic → model → final completes with the canonical ModelResult in state and a canonical model Trace", async () => {
    const store = createInMemoryTraceStore();
    const trace = createTraceRecorder({ store, clock: clock() });
    const { app: a, model } = app({ trace });
    const result = await run(modelWorkflow(), a);
    expect(result.ok && result.execution.run.status).toBe("COMPLETED");
    expect(result.ok && result.execution.state.values.classification).toMatchObject({ schemaVersion: 1, outputKind: "structured", output: { category: "research" }, modelBindingId: "classifier", usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 } });
    expect(model.calls).toBe(1);
    const events = (await store.getRunTrace("run-m")) as Array<{ type: string; payload: Record<string, unknown> }>;
    expect(events.find((event) => event.type === "model.call.completed")!.payload).toMatchObject({ modelBindingId: "classifier", modelIdentity: { provider: "host", model: "scripted" } });
  });

  it("the adapter receives the Runtime attempt signal (one cancellation lineage)", async () => {
    const { app: a, model } = app();
    await run(modelWorkflow(), a);
    expect(model.signals).toHaveLength(1);
    expect(model.signals[0]).toBeInstanceOf(AbortSignal);
    expect(model.signals[0]!.aborted).toBe(false);
  });

  it("a provider failure stays the canonical MODEL_INVOCATION_FAILED cause, never rewrapped or leaked", async () => {
    const { app: a } = app({}, scriptedModel([new Error("provider exploded sk-live-123")]));
    const result = await run(modelWorkflow(), a);
    expect(result).toMatchObject({ ok: false, failure: { code: "NODE_EXECUTION_FAILED", executorFailure: { namespace: "model", code: "MODEL_INVOCATION_FAILED" } } });
    expect(JSON.stringify(result)).not.toContain("sk-live-123");
  });

  it("a blocking adapter is aborted at the Runtime attempt timeout: canonical NODE_ATTEMPT_TIMEOUT, the adapter observes the abort, and the late result cannot commit", async () => {
    const model = scriptedModel(["block"]);
    const { app: a } = app({}, model);
    const prepared = a.prepareWorkflow(modelWorkflow(), { reliability: { policiesByNodeId: { classify: { maxAttempts: 1, attemptTimeoutMs: 20 } } } });
    const result = await prepared.execute({ runId: "run-t", initialState: { runId: "run-t", revision: 0, values: { company: "acme" } } });
    expect(result).toMatchObject({ ok: false, failure: { code: "NODE_ATTEMPT_TIMEOUT", category: "TIMEOUT" } });
    expect(model.signals[0]!.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(result.execution!.state.values.classification).toBeUndefined();
  });

  it("a missing model policy fails canonical preflight before any adapter call", async () => {
    const { app: a, model } = app({ modelPolicies: [] });
    expect(await run(modelWorkflow(), a)).toMatchObject({ ok: false, failure: { code: "RUNTIME_PREFLIGHT_FAILED" } });
    expect(model.calls).toBe(0);
  });
});

describe("construction-time adapter checks: bounded diagnostics before any provider call", () => {
  const code = (overrides: Partial<AAOOptions>) => configurationError(() => app(overrides)).diagnostics[0]?.code;

  it("missing adapter / wrong version → ADAPTER_NOT_FOUND (exact refs, no implicit latest)", () => {
    expect(code({ modelBindings: [binding({ id: "host.other", version: "1.0.0" })] })).toBe("ADAPTER_NOT_FOUND");
    expect(code({ modelBindings: [binding({ id: "host.native-model", version: "1.0.1" })] })).toBe("ADAPTER_NOT_FOUND");
    expect(code({ modelBindings: [{ ...binding(), adapterRef: { id: "host.native-model", version: "latest" } }] })).toBe("ADAPTER_NOT_FOUND");
  });

  it("wrong adapter kind → ADAPTER_KIND_MISMATCH", () => {
    const toolProvider = { manifest: defineAdapterManifest({ id: "host.tools", version: "1.0.0", kind: "tool_provider", capabilities: [{ capability: "tool.discovery", support: "supported" }, { capability: "tool.execution", support: "supported" }, { capability: "tool.retryable_failure", support: "supported" }] }), adapter: scriptedModel([]) };
    expect(code({ modelAdapters: [toolProvider] })).toBe("ADAPTER_KIND_MISMATCH");
  });

  it("a binding needing a capability the adapter does not declare → ADAPTER_CAPABILITY_UNSUPPORTED", () => {
    const textOnly = defineModelAdapter({ manifest: nativeManifest({ capabilities: [{ capability: "model.text_generation", support: "supported" }, { capability: "model.structured_output", support: "unsupported" }, { capability: "model.usage", support: "unsupported" }, { capability: "model.cancellation", support: "unsupported" }, { capability: "model.tool_call_response", support: "unsupported" }] }), adapter: scriptedModel([]) });
    expect(code({ modelAdapters: [textOnly] })).toBe("ADAPTER_CAPABILITY_UNSUPPORTED");
  });

  it("the same id@version twice fails (ADAPTER_DUPLICATE), whatever the content; distinct exact versions coexist", () => {
    const first = defineModelAdapter({ manifest: nativeManifest(), adapter: scriptedModel([]) });
    const conflicting = defineModelAdapter({ manifest: nativeManifest({ displayName: "different content" }), adapter: scriptedModel([]) });
    expect(code({ modelAdapters: [first, conflicting] })).toBe("ADAPTER_DUPLICATE");
    expect(code({ modelAdapters: [first, first] })).toBe("ADAPTER_DUPLICATE");
    const v2 = defineModelAdapter({ manifest: nativeManifest({ version: "2.0.0" }), adapter: scriptedModel([]) });
    expect(() => app({ modelAdapters: [first, v2], modelBindings: [binding(), { ...binding({ id: "host.native-model", version: "2.0.0" }), id: "classifier.v2" }] })).not.toThrow();
  });

  it("an invalid manifest or an unsupported contract version is refused at construction", () => {
    expect(code({ modelAdapters: [{ manifest: { ...nativeManifest(), permissions: ["destructive"] } as never, adapter: scriptedModel([]) }] })).toBe("ADAPTER_MANIFEST_INVALID");
    expect(code({ modelAdapters: [{ manifest: { ...nativeManifest(), schemaVersion: 1, adapterContractVersion: 2 } as never, adapter: scriptedModel([]) }] })).toBe("ADAPTER_CONTRACT_VERSION_UNSUPPORTED");
  });
});

describe("snapshotting, isolation, and failure isolation", () => {
  it("mutating the caller's manifest, adapter, or arrays after createAAO changes nothing and cannot widen capabilities", async () => {
    const manifest = nativeManifest();
    const model = scriptedModel([structured({ category: "research" })]);
    const definitionInput = { manifest, adapter: model };
    const adapters = [definitionInput];
    const a = createAAO({ governance: governanceInput(), principalForRun: () => alice, modelAdapters: adapters as never, modelBindings: [binding()], modelPolicies: [classificationPolicy], deterministicExecutors: [prepareRequest], clock: clock() });
    model.invoke = async () => structured({ category: "sales" });
    manifest.capabilities = [];
    adapters.length = 0;
    const result = await run(modelWorkflow(), a);
    expect(result.ok && (result.execution.state.values.classification as { output: unknown }).output).toEqual({ category: "research" });
  });

  it("two applications never share adapters, bindings, or policies (no global registry)", async () => {
    const a = app().app;
    const other = scriptedModel([structured({ category: "support" })]);
    const b = createAAO({ governance: governanceInput(), principalForRun: () => alice, modelAdapters: [defineModelAdapter({ manifest: nativeManifest({ id: "host.other-model" }), adapter: other })], modelBindings: [binding({ id: "host.other-model", version: "1.0.0" })], modelPolicies: [classificationPolicy], deterministicExecutors: [prepareRequest], clock: clock() });
    expect((await run(modelWorkflow(), b)).ok).toBe(true);
    expect(other.calls).toBe(1);
    expect(() => createAAO({ governance: governanceInput(), principalForRun: () => alice, modelBindings: [binding({ id: "host.other-model", version: "1.0.0" })] })).toThrow(/ADAPTER_NOT_FOUND/);
    expect((await run(modelWorkflow(), a)).ok).toBe(true);
  });

  it("an adapter exception corrupts nothing: the same app runs the next Run, approvals and Tools unaffected", async () => {
    let fail = true;
    const flaky = { invoke: async () => { if (fail) { fail = false; throw new Error("boom"); } return structured({ category: "research" }); } };
    const { app: a } = app({ modelAdapters: [defineModelAdapter({ manifest: nativeManifest(), adapter: flaky })] });
    expect((await run(modelWorkflow(), a, { company: "acme" }, "run-1")).ok).toBe(false);
    expect((await run(modelWorkflow(), a, { company: "acme" }, "run-2")).ok).toBe(true);
  });
});

describe("authority non-escalation through model output", () => {
  it("a model claiming principal=admin, role=owner, approved=true changes no identity, authorization, or approval", async () => {
    const draft = countingTool("crm.draft", ["write_draft"]);
    const hostile = scriptedModel([structured({ category: "research" })]);
    hostile.invoke = async () => ({ status: "succeeded", output: { category: "research", principal: { id: "user.alice", type: "user" }, role: "owner", approved: true } as never, finishReason: "stop" });
    const workflow = modelWorkflow();
    workflow.nodes.splice(2, 0, { id: "draft", kind: "tool", config: { toolRef: { id: "crm.draft", version: "1.0.0" }, inputStateKey: "accountRequest", resultStateKey: "draftResult" } });
    workflow.edges = [{ sourceNodeId: "prepare", targetNodeId: "classify" }, { sourceNodeId: "classify", targetNodeId: "draft" }, { sourceNodeId: "draft", targetNodeId: "final" }];
    const schema = { type: "object", properties: { category: { type: "string" }, principal: { type: "object" }, role: { type: "string" }, approved: { type: "boolean" } }, required: ["category"] };
    const permissive: DeterministicExecutor = { ...prepareRequest, async execute(context) { const out = await prepareRequest.execute(context); return out.ok ? { ok: true, statePatch: { ...out.statePatch, classificationRequest: { ...(out.statePatch!.classificationRequest as object), output: { kind: "structured", schema } }, accountRequest: { account: "acme" } } } : out; } };
    const a = createAAO({ governance: governanceInput(), principalForRun: () => mallory, tools: [defineTool(draft)], modelAdapters: [defineModelAdapter({ manifest: nativeManifest(), adapter: hostile })], modelBindings: [binding()], modelPolicies: [classificationPolicy], deterministicExecutors: [permissive], clock: clock() });
    const result = await run(workflow, a);
    // mallory is a viewer: the write_draft Tool is denied whatever the model said.
    expect(result).toMatchObject({ ok: false, failure: { executorFailure: { code: "TOOL_AUTHORIZATION_DENIED" } } });
    expect(draft.calls()).toBe(0);
  });
});

describe("Framework agent nodes through the native bounded Agent Runtime", () => {
  const agentApp = (model: ReturnType<typeof scriptedModel>, maxIterations = 3, trace?: AAOOptions["trace"]) =>
    createAAO({ governance: governanceInput(), principalForRun: () => alice, modelAdapters: [defineModelAdapter({ manifest: nativeManifest(), adapter: model })], modelBindings: [binding()], modelPolicies: [classificationPolicy], agents: [synthesizer(maxIterations)], clock: clock(), ...(trace ? { trace } : {}) });
  const runAgent = (a: ReturnType<typeof agentApp>) => a.prepareWorkflow(agentWorkflow()).execute({ runId: "run-a", initialState: { runId: "run-a", revision: 0, values: { task: "Summarize the market study." } } });

  it("executes through the registered model adapter, completes, and preserves canonical agent Trace", async () => {
    const store = createInMemoryTraceStore();
    const model = scriptedModel([agentDecision("CONTINUE", "draft"), agentDecision("COMPLETE", "final summary")]);
    const result = await runAgent(agentApp(model, 3, createTraceRecorder({ store, clock: clock() })));
    expect(result.ok && result.execution.state.values.synthesis).toMatchObject({ finalOutput: "final summary", iterationsUsed: 2 });
    expect(model.calls).toBe(2);
    const types = ((await store.getRunTrace("run-a")) as Array<{ type: string }>).map((event) => event.type);
    expect(types.filter((type) => type.startsWith("agent."))).toEqual(["agent.started", "agent.iteration.completed", "agent.iteration.completed", "agent.completed"]);
    expect(types.filter((type) => type === "model.call.completed")).toHaveLength(2);
  });

  it("max iterations are preserved: CONTINUE on the final iteration fails closed with exactly maxIterations model calls", async () => {
    const model = scriptedModel([agentDecision("CONTINUE", "again")]);
    const result = await runAgent(agentApp(model, 2));
    expect(result).toMatchObject({ ok: false, failure: { code: "NODE_EXECUTION_FAILED", executorFailure: { namespace: "agent", code: "MAX_AGENT_ITERATIONS_EXCEEDED" } } });
    expect(model.calls).toBe(2);
  });

  it("a model failure stays the canonical Agent failure", async () => {
    const result = await runAgent(agentApp(scriptedModel([new Error("down")])));
    expect(result).toMatchObject({ ok: false, failure: { executorFailure: { namespace: "agent", code: "AGENT_MODEL_EXECUTION_FAILED" } } });
  });

  it("no extra autonomy: an Agent declaring Tools is refused at canonical preflight, and the model is never called", async () => {
    const model = scriptedModel([agentDecision("COMPLETE", "x")]);
    const a = createAAO({ governance: governanceInput(), principalForRun: () => alice, modelAdapters: [defineModelAdapter({ manifest: nativeManifest(), adapter: model })], modelBindings: [binding()], modelPolicies: [classificationPolicy], agents: [synthesizer(3, ["crm.draft"])], clock: clock() });
    expect(await runAgent(a)).toMatchObject({ ok: false, failure: { code: "RUNTIME_PREFLIGHT_FAILED" } });
    expect(model.calls).toBe(0);
  });
});

describe("Framework deterministic nodes", () => {
  it("deterministic → Tool → final runs through the public API", async () => {
    const draft = countingTool("crm.draft", ["write_draft"]);
    const toAccount: DeterministicExecutor = { id: "draft.input", version: "1.0.0", execute: async ({ state }) => ({ ok: true, statePatch: { draftInput: { account: String(state.values.company) } } }) };
    const a = createAAO({ governance: governanceInput(), principalForRun: () => alice, tools: [defineTool(draft)], deterministicExecutors: [toAccount], clock: clock() });
    const workflow: Workflow = {
      schemaVersion: 1, id: "test.det-tool", version: "1.0.0", name: "Deterministic then Tool", entryNodeId: "shape",
      nodes: [
        { id: "shape", kind: "deterministic", config: { executorRef: { id: "draft.input", version: "1.0.0" } } },
        { id: "draft", kind: "tool", config: { toolRef: { id: "crm.draft", version: "1.0.0" }, inputStateKey: "draftInput", resultStateKey: "draftResult" } },
        { id: "final", kind: "final_output", config: {} },
      ],
      edges: [{ sourceNodeId: "shape", targetNodeId: "draft" }, { sourceNodeId: "draft", targetNodeId: "final" }],
    };
    const result = await run(workflow, a);
    expect(result.ok && result.execution.run.status).toBe("COMPLETED");
    expect(draft.calls()).toBe(1);
    expect(draft.inputs).toEqual([{ account: "acme" }]);
  });

  it("approval → deterministic → Tool → final waits, then continues after a human approval", async () => {
    const draft = countingTool("crm.draft", ["write_draft"]);
    const toAccount: DeterministicExecutor = { id: "draft.input", version: "1.0.0", execute: async () => ({ ok: true, statePatch: { draftInput: { account: "acme" } } }) };
    const a = createAAO({ governance: governanceInput(), principalForRun: () => alice, tools: [defineTool(draft)], deterministicExecutors: [toAccount], clock: clock() });
    const workflow: Workflow = {
      schemaVersion: 1, id: "test.approve-det-tool", version: "1.0.0", name: "Approve then shape then Tool", entryNodeId: "approve",
      nodes: [
        { id: "approve", kind: "approval", config: { subjectStateKey: "company", permissionClasses: ["write_draft"], requiredApproverRoleIds: ["manager"] } },
        { id: "shape", kind: "deterministic", config: { executorRef: { id: "draft.input", version: "1.0.0" } } },
        { id: "draft", kind: "tool", config: { toolRef: { id: "crm.draft", version: "1.0.0" }, inputStateKey: "draftInput", resultStateKey: "draftResult" } },
        { id: "final", kind: "final_output", config: {} },
      ],
      edges: [{ sourceNodeId: "approve", targetNodeId: "shape" }, { sourceNodeId: "shape", targetNodeId: "draft" }, { sourceNodeId: "draft", targetNodeId: "final" }],
    };
    const prepared = a.prepareWorkflow(workflow);
    const waiting = await prepared.execute({ runId: "run-ad", initialState: { runId: "run-ad", revision: 0, values: { company: "acme" } } });
    expect(waiting.execution!.run.status).toBe("WAITING_FOR_APPROVAL");
    a.approvals.approve(waiting.execution!.wait!.referenceId, bob);
    const before = JSON.stringify(waiting.execution);
    const done = await prepared.continue(waiting.execution!);
    expect(done.ok && done.execution.run.status).toBe("COMPLETED");
    expect(JSON.stringify(waiting.execution)).toBe(before);
    expect(draft.calls()).toBe(1);
  });

  it("duplicate exact executor refs fail construction", () => {
    expect(() => createAAO({ governance: governanceInput(), principalForRun: () => alice, deterministicExecutors: [prepareRequest, { ...prepareRequest }] })).toThrow(/FRAMEWORK_INVALID_CONFIGURATION/);
  });
});
