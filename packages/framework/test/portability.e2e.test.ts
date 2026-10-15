import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildEvalComparisonKey, createEvaluatorRegistry, deterministicGraders, runEvalDataset, semanticVerdictFingerprint } from "@aao/evaluation";
import { createMcpSession, createMcpToolBinding, type McpSession } from "@aao/mcp-connector";
import { VERCEL_AI_SDK_ADAPTER_MANIFEST } from "@aao/model-runtime/vercel-ai";
import { createVercelAiConformanceSubject } from "@aao/model-runtime/vercel-ai/conformance";
import { ADAPTER_CONFORMANCE_SCENARIOS } from "@aao/adapters";
import { createInMemoryTraceStore, createTraceRecorder } from "@aao/observability";
import { createAAO, defineModelAdapter, defineTool, type ModelAdapterDefinition, type ToolDefinition, type ToolSpec, type Workflow } from "../src/index.js";
import { classificationPolicy, nativeManifest, prepareRequest, scriptedModel, structured } from "./model-support.js";
import { alice, bob, governanceInput } from "./support.js";

/**
 * Sprint 20 portability proof (ADR-025). ONE logical Workflow, unchanged,
 * runs twice through @aao/framework:
 *
 *   A: native model reference + native Tool (local handler)
 *   B: Vercel AI SDK adapter (deterministic ai/test model) + MCP Tool provider (stdio)
 *
 * Only host binding configuration differs. The same Eval definitions must
 * reach the same comparison keys and semantic verdicts, and the Workflow
 * identity, node trajectory, governance and approval behavior, and final
 * state shape must agree. Trace bytes need not match.
 */
const SERVER = fileURLToPath(new URL("../../mcp-connector/conformance/server.mjs", import.meta.url));
const sessions: McpSession[] = [];
afterAll(async () => {
  await Promise.all(sessions.map((session) => session.close()));
});

const ACCOUNT_SPEC: ToolSpec = {
  schemaVersion: 1, id: "crm.account.read", version: "1.0.0", name: "Read account", description: "Host policy",
  inputSchema: { type: "object", properties: { accountId: { type: "string", minLength: 1 } }, required: ["accountId"], additionalProperties: false },
  outputSchema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id", "name"], additionalProperties: false },
  permissionClasses: ["read_only"],
};

/** The portable Workflow: canonical references only (a model policy, a Tool identity, an executor ref). No vendor appears. */
const PORTABLE: Workflow = {
  schemaVersion: 1, id: "research.classify-and-read", version: "1.0.0", name: "Classify a request and read the account", entryNodeId: "prepare",
  nodes: [
    { id: "prepare", kind: "deterministic", config: { executorRef: { id: "classify.prepare-request", version: "1.0.0" } } },
    { id: "classify", kind: "model", config: { modelPolicyRef: "policy.classification", requestStateKey: "classificationRequest", resultStateKey: "classification" } },
    { id: "approve", kind: "approval", config: { subjectStateKey: "accountRequest", permissionClasses: ["read_only"], requiredApproverRoleIds: ["manager"] } },
    { id: "read", kind: "tool", config: { toolRef: { id: "crm.account.read", version: "1.0.0" }, inputStateKey: "accountRequest", resultStateKey: "account" } },
    { id: "final", kind: "final_output", config: {} },
  ],
  edges: [
    { sourceNodeId: "prepare", targetNodeId: "classify" },
    { sourceNodeId: "classify", targetNodeId: "approve" },
    { sourceNodeId: "approve", targetNodeId: "read" },
    { sourceNodeId: "read", targetNodeId: "final" },
  ],
};


async function configurationA(): Promise<{ model: ModelAdapterDefinition; tool: ToolDefinition; adapterRef: { id: string; version: string } }> {
  const model = defineModelAdapter({ manifest: nativeManifest(), adapter: scriptedModel([structured({ category: "research" })]) });
  const tool = defineTool({ spec: ACCOUNT_SPEC, handler: { execute: async ({ input }) => ({ ok: true, output: { id: (input as { accountId: string }).accountId, name: "Local Test Account" } }) } });
  return { model, tool, adapterRef: { id: "host.native-model", version: "1.0.0" } };
}

async function configurationB(): Promise<{ model: ModelAdapterDefinition; tool: ToolDefinition; adapterRef: { id: string; version: string } }> {
  // The production Vercel AI SDK adapter over the SDK's deterministic ai/test model, as shipped for conformance (the Framework never depends on `ai`).
  const structuredScenario = ADAPTER_CONFORMANCE_SCENARIOS.find((scenario) => scenario.id === "model.structured-output")!;
  const model = defineModelAdapter({ manifest: VERCEL_AI_SDK_ADAPTER_MANIFEST, adapter: createVercelAiConformanceSubject().prepare(structuredScenario).adapter });
  const session = createMcpSession({ command: process.execPath, args: [SERVER, JSON.stringify({ outcomes: ["success"], hostile: true })] });
  sessions.push(session);
  await session.connect();
  const tool = defineTool(await createMcpToolBinding({ session, remoteToolName: "crm.read_account", spec: ACCOUNT_SPEC }));
  return { model, tool, adapterRef: { id: "aao.vercel-ai-sdk", version: "1.0.0" } };
}

async function runPortable(configuration: Awaited<ReturnType<typeof configurationA>>) {
  let tick = 0;
  const clock = { now: () => new Date(Date.UTC(2026, 9, 14, 7, 0, tick++)).toISOString() };
  const store = createInMemoryTraceStore();
  const trace = createTraceRecorder({ store, clock });
  const app = createAAO({
    governance: governanceInput(),
    principalForRun: () => alice,
    tools: [configuration.tool],
    modelAdapters: [configuration.model],
    // Host deployment configuration: the only place an adapter is named.
    modelBindings: [{ id: "classifier", priority: 10, capabilities: ["model.text_generation", "model.structured_output"], identity: { provider: "portable", model: "classifier" }, adapterRef: configuration.adapterRef }],
    modelPolicies: [classificationPolicy],
    deterministicExecutors: [prepareRequest],
    trace,
    clock,
  });
  const prepared = app.prepareWorkflow(PORTABLE);
  const runId = "run.portable";
  const waiting = await prepared.execute({ runId, initialState: { runId, revision: 0, values: { company: "a-1" } } });
  const approvalId = waiting.execution!.wait!.referenceId;
  const selfApproval = (() => { try { app.approvals.approve(approvalId, alice); return "approved"; } catch (error) { return (error as { code?: string }).code; } })();
  app.approvals.approve(approvalId, bob);
  const done = await prepared.continue(waiting.execution!);
  return { planFingerprint: prepared.planFingerprint, waiting, done, selfApproval, trace: await store.getRunTrace(runId), runId };
}

const definition = (id: string, grader: string, version: string, targetType: string, config: object) => ({ schemaVersion: 2, id, version: "1.0.0", name: id, categories: ["capability"], supportedModes: ["RUNTIME"], targetType, graderRef: { id: grader, version }, config });
const DEFINITIONS = [
  definition("portable.completed", "aao.run-outcome", "1.0.0", "run", { expectedStatus: "COMPLETED" }),
  definition("portable.trajectory", "aao.trajectory", "1.0.0", "run", { nodeSequence: { mode: "exact", nodes: ["prepare", "classify", "approve", "read", "final"] } }),
  definition("portable.model-call", "aao.model-call", "1.0.0", "run", { expectedCalls: { min: 1, max: 1 }, expectedIdentity: { provider: "portable", model: "classifier" }, expectedOutcome: "completed" }),
  definition("portable.tool-once", "aao.tool-usage", "1.0.0", "tool_use", { requiredTools: [{ id: "crm.account.read", version: "1.0.0" }], callLimits: [{ tool: { id: "crm.account.read", version: "1.0.0" }, count: "physical", min: 1, max: 1 }] }),
  definition("portable.approval", "aao.approval-compliance", "2.0.0", "approval", { approvalRequired: true, expectedRequestCount: 1, expectedResolution: "approved", guardApprovalNodeId: "approve", noToolBeforeApproval: true }),
  definition("portable.state", "aao.state-assertion", "1.0.0", "state", { checks: [{ id: "category", op: "path_equals", path: "/classification/output/category", value: "research" }, { id: "account", op: "path_equals", path: "/account/output/name", value: "Local Test Account" }] }),
];
const DATASET = { schemaVersion: 2, id: "portable.semantics", version: "1.0.0", name: "Portable semantics", cases: DEFINITIONS.map((entry) => ({ id: `${entry.id}.001`, evalRef: { id: entry.id, version: "1.0.0" }, mode: "RUNTIME", evidenceRef: "run://portable", expected: { status: "passed" } })) };

async function judge(outcome: Awaited<ReturnType<typeof runPortable>>) {
  const evidence = { origin: "live_run", runId: outcome.runId, trace: outcome.trace, execution: outcome.done.execution };
  const judged = await runEvalDataset({ dataset: DATASET as never, definitions: DEFINITIONS, registry: createEvaluatorRegistry(deterministicGraders()), evidenceResolver: { resolve: (ref) => (ref === "run://portable" ? (evidence as never) : undefined) } });
  if (!judged.ok) throw new Error(JSON.stringify(judged));
  return judged.run.cases.map((entry) => ({ caseId: entry.caseId, status: entry.result.status, comparisonKey: buildEvalComparisonKey(entry.result), semantic: semanticVerdictFingerprint(entry.result) }));
}

describe("cross-adapter portability: one Workflow, alternate bindings, same AAO semantics", () => {
  it("the Workflow names no vendor, protocol, or framework", () => {
    expect(JSON.stringify(PORTABLE)).not.toMatch(/vercel|mcp|openai|anthropic|langgraph|ai-sdk/i);
  });

  it("native model + native Tool vs Vercel AI SDK + MCP: same identity, trajectory, governance, approval, state shape, and semantic Eval verdicts", async () => {
    const a = await runPortable(await configurationA());
    const b = await runPortable(await configurationB());

    expect(a.planFingerprint).toBe(b.planFingerprint);
    for (const outcome of [a, b]) {
      expect(outcome.waiting.execution!.run.status).toBe("WAITING_FOR_APPROVAL");
      expect(outcome.selfApproval).toBe("APPROVAL_RESOLVER_NOT_ELIGIBLE");
      expect(outcome.done.ok && outcome.done.execution.run.status).toBe("COMPLETED");
    }
    const trajectory = (outcome: typeof a) => outcome.done.execution!.history.map((record) => `${record.nodeId}:${record.status}:${record.attemptCount}`);
    expect(trajectory(a)).toEqual(trajectory(b));
    expect(trajectory(a)).toEqual(["prepare:SUCCEEDED:1", "classify:SUCCEEDED:1", "approve:SUCCEEDED:1", "read:SUCCEEDED:1", "final:SUCCEEDED:1"]);
    const shape = (outcome: typeof a) => Object.keys(outcome.done.execution!.state.values).sort();
    expect(shape(a)).toEqual(shape(b));
    const semantic = (outcome: typeof a) => {
      const values = outcome.done.execution!.state.values as Record<string, { output?: unknown; modelBindingId?: string }>;
      return { category: values.classification?.output, binding: values.classification?.modelBindingId, account: values.account?.output };
    };
    expect(semantic(a)).toEqual(semantic(b));

    const verdictsA = await judge(a);
    const verdictsB = await judge(b);
    expect(verdictsA.every((entry) => entry.status === "passed")).toBe(true);
    expect(verdictsB).toEqual(verdictsA);
    // Equality is judged on semantic verdicts, never on Trace bytes, which may or may not coincide across substrates.
  }, 60_000);
});
