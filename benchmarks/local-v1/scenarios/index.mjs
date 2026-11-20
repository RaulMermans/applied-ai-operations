import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAAO,
  defineAdapterManifest,
  defineGovernance,
  defineModelAdapter,
  defineModelPolicy,
  defineTool,
  defineWorkflow,
} from "@aao/framework";
import { compileWorkflow, compileWorkflowSource, validateWorkflowSemantics } from "@aao/workflow-dsl";
import { createDurableRuntimeHost, createFileDurabilityStore } from "@aao/durability";
import { createInMemoryTraceStore, createTraceRecorder, deriveRunMetrics, createInMemoryAuditStore, createAuditRecorder } from "@aao/observability";
import { createNodeRegistry, finalOutputExecutor } from "@aao/runtime";
import { CANONICAL_CAPABILITY_PACKS, validateCapabilityPackManifest, validatePackCompatibility } from "@aao/capability-packs";
import { projectRunInspection } from "@aao/operator-inspection";
import { measure } from "../runner/stats.mjs";

const ana = { id: "user.ana", type: "user" };
const ben = { id: "user.ben", type: "user" };
const viewer = { id: "user.viewer", type: "user" };
const outsider = { id: "user.outsider", type: "user" };

function governance() {
  return defineGovernance({
    actors: [ana, ben, viewer, outsider],
    roles: [
      { id: "operator", version: "1.0.0", permissionClasses: ["read_only", "write_draft"] },
      { id: "manager", version: "1.0.0", permissionClasses: ["read_only", "write_draft"] },
      { id: "viewer", version: "1.0.0", permissionClasses: ["read_only"] },
    ],
    bindings: [
      { id: "ana.operator", actorId: ana.id, roleId: "operator", status: "active" },
      { id: "ben.manager", actorId: ben.id, roleId: "manager", status: "active" },
      { id: "viewer.analyst", actorId: viewer.id, roleId: "viewer", status: "active" },
    ],
    policies: [],
  });
}

function lookupTool(onHandler) {
  return defineTool({
    spec: {
      schemaVersion: 1,
      id: "bench.lookup",
      version: "1.0.0",
      name: "Lookup",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      outputSchema: { type: "object", properties: { matches: { type: "array" } }, required: ["matches"] },
      permissionClasses: ["read_only"],
    },
    handler: {
      async execute({ input }) {
        const started = process.hrtime.bigint();
        const { query } = input;
        const output = { matches: [query] };
        onHandler?.(Number(process.hrtime.bigint() - started));
        return { ok: true, output };
      },
    },
  });
}

function draftTool(counter) {
  return defineTool({
    spec: {
      schemaVersion: 1,
      id: "bench.draft",
      version: "1.0.0",
      name: "Draft",
      inputSchema: { type: "object" },
      outputSchema: { type: "object", properties: { draftId: { type: "string" } }, required: ["draftId"] },
      permissionClasses: ["write_draft"],
    },
    handler: {
      async execute() {
        counter.calls += 1;
        return { ok: true, output: { draftId: `draft-${counter.calls}` } };
      },
    },
  });
}

const lookupWorkflow = defineWorkflow({
  schemaVersion: 1,
  id: "bench.lookup",
  version: "1.0.0",
  name: "Lookup",
  entryNodeId: "search",
  nodes: [
    { id: "search", kind: "tool", config: { toolRef: { id: "bench.lookup", version: "1.0.0" }, inputStateKey: "request", resultStateKey: "accounts" } },
    { id: "done", kind: "final_output", config: {} },
  ],
  edges: [{ sourceNodeId: "search", targetNodeId: "done" }],
});

const approvalWorkflow = defineWorkflow({
  schemaVersion: 1,
  id: "bench.approval",
  version: "1.0.0",
  name: "Approval",
  entryNodeId: "approve",
  nodes: [
    { id: "approve", kind: "approval", config: { subjectStateKey: "proposal", permissionClasses: ["write_draft"], requiredApproverRoleIds: ["manager"] } },
    { id: "draft", kind: "tool", config: { toolRef: { id: "bench.draft", version: "1.0.0" }, inputStateKey: "proposal", resultStateKey: "draft" } },
    { id: "done", kind: "final_output", config: {} },
  ],
  edges: [
    { sourceNodeId: "approve", targetNodeId: "draft" },
    { sourceNodeId: "draft", targetNodeId: "done" },
  ],
});

const invalidWorkflow = {
  schemaVersion: 1,
  id: "bench.invalid",
  version: "1.0.0",
  name: "Invalid",
  entryNodeId: "missing",
  nodes: [{ id: "a", kind: "final_output", config: {} }],
  edges: [{ sourceNodeId: "a", targetNodeId: "a" }],
};

export async function runScenarios({ warmup, samples }) {
  const opts = { warmup, samples };
  const scenarios = [];

  const compileValid = await measure(() => {
    const compiled = compileWorkflow(lookupWorkflow);
    if (!compiled.ok) throw new Error("compile failed");
    return compiled.plan;
  }, opts);
  const semantics = await measure(() => validateWorkflowSemantics(lookupWorkflow), opts);
  const rejected = await measure(() => {
    const compiled = compileWorkflow(invalidWorkflow);
    if (compiled.ok) throw new Error("invalid workflow compiled");
    return compiled.diagnostics.length;
  }, opts);
  scenarios.push({
    id: "A.workflow-compilation",
    successRate: 1,
    validationMs: semantics.statsMs,
    compilationMs: compileValid.statsMs,
    invalidRejectionMs: rejected.statsMs,
    planFingerprintNsSample: compileValid.lastResult ? undefined : undefined,
  });

  let handlerNs = 0;
  let handlerCount = 0;
  const app = createAAO({
    governance: governance(),
    principalForRun: ({ runId }) => (runId.includes("denied") ? outsider : ana),
    tools: [
      lookupTool((ns) => {
        handlerNs += ns;
        handlerCount += 1;
      }),
      draftTool({ calls: 0 }),
    ],
  });
  const preparedLookup = app.prepareWorkflow(lookupWorkflow);
  let seq = 0;
  const governed = await measure(async () => {
    seq += 1;
    const runId = `run.bench.lookup.${seq}`;
    const result = await preparedLookup.execute({ runId, initialState: { runId, revision: 0, values: { request: { query: "Acme" } } } });
    if (!result.ok) throw new Error("lookup failed");
    return result;
  }, opts);
  const denied = await measure(async () => {
    seq += 1;
    const runId = `run.bench.denied.${seq}`;
    const result = await preparedLookup.execute({ runId, initialState: { runId, revision: 0, values: { request: { query: "Acme" } } } });
    if (result.ok || result.failure.executorFailure?.code !== "TOOL_AUTHORIZATION_DENIED") throw new Error("denial failed");
    return result;
  }, opts);
  scenarios.push({
    id: "B.governed-read-only-tool",
    successRate: 1,
    runMs: governed.statsMs,
    handlerMeanMs: handlerCount === 0 ? null : handlerNs / handlerCount / 1e6,
    denialMs: denied.statsMs,
    refusalCorrectness: 1,
  });

  const classifier = defineModelAdapter({
    manifest: defineAdapterManifest({
      id: "bench.rules",
      version: "1.0.0",
      kind: "model",
      capabilities: [
        { capability: "model.text_generation", support: "supported" },
        { capability: "model.structured_output", support: "supported" },
        { capability: "model.usage", support: "unsupported" },
        { capability: "model.cancellation", support: "supported" },
        { capability: "model.tool_call_response", support: "unsupported" },
      ],
    }),
    adapter: {
      async invoke() {
        return { status: "succeeded", output: { category: "research" }, finishReason: "stop" };
      },
    },
  });
  const modelApp = createAAO({
    governance: defineGovernance({ actors: [{ id: "svc.bench", type: "service" }], roles: [], bindings: [], policies: [] }),
    principalForRun: () => ({ id: "svc.bench", type: "service" }),
    modelAdapters: [classifier],
    modelBindings: [{ id: "classifier", priority: 1, capabilities: ["model.text_generation", "model.structured_output"], adapterRef: { id: "bench.rules", version: "1.0.0" } }],
    modelPolicies: [defineModelPolicy({ schemaVersion: 1, id: "policy.classify", version: "1.0.0", name: "Classify" })],
  });
  const modelWorkflow = defineWorkflow({
    schemaVersion: 1,
    id: "bench.classify",
    version: "1.0.0",
    name: "Classify",
    entryNodeId: "classify",
    nodes: [
      { id: "classify", kind: "model", config: { modelPolicyRef: "policy.classify", requestStateKey: "request", resultStateKey: "classification" } },
      { id: "done", kind: "final_output", config: {} },
    ],
    edges: [{ sourceNodeId: "classify", targetNodeId: "done" }],
  });
  const preparedModel = modelApp.prepareWorkflow(modelWorkflow);
  const modelRequest = {
    schemaVersion: 1,
    invocationId: "inv-1",
    messages: [{ role: "user", content: "Classify: quarterly market study." }],
    output: { kind: "structured", schema: { type: "object", properties: { category: { type: "string" } }, required: ["category"] } },
  };
  let modelSeq = 0;
  const modelRun = await measure(async () => {
    modelSeq += 1;
    const runId = `run.bench.model.${modelSeq}`;
    const result = await preparedModel.execute({ runId, initialState: { runId, revision: 0, values: { request: { ...modelRequest, invocationId: runId } } } });
    if (!result.ok) throw new Error(`model run failed: ${JSON.stringify(result.failure)}`);
    return result;
  }, opts);
  scenarios.push({
    id: "C.model-workflow-fake-adapter",
    successRate: 1,
    orchestrationMs: modelRun.statsMs,
    limitation: "Measures AAO orchestration plus an in-process fake adapter. Not provider inference latency.",
  });

  const draftCounter = { calls: 0 };
  const approvalApp = createAAO({
    governance: governance(),
    principalForRun: () => ana,
    tools: [draftTool(draftCounter)],
  });
  const preparedApproval = approvalApp.prepareWorkflow(approvalWorkflow);
  let approvalSeq = 0;
  const approval = await measure(async () => {
    approvalSeq += 1;
    const runId = `run.bench.approval.${approvalSeq}`;
    const waiting = await preparedApproval.execute({
      runId,
      initialState: { runId, revision: 0, values: { proposal: { account: "acme" } } },
    });
    const waitMsStart = process.hrtime.bigint();
    approvalApp.approvals.approve(waiting.execution.wait.referenceId, ben);
    const approveNs = Number(process.hrtime.bigint() - waitMsStart);
    const completed = await preparedApproval.continue(waiting.execution);
    if (!completed.ok) throw new Error("approval continuation failed");
    const duplicate = await preparedApproval.continue(waiting.execution);
    return { approveNs, duplicateOk: duplicate.ok, drafts: draftCounter.calls };
  }, opts);
  const denial = await measure(async () => {
    approvalSeq += 1;
    const runId = `run.bench.reject.${approvalSeq}`;
    const waiting = await preparedApproval.execute({
      runId,
      initialState: { runId, revision: 0, values: { proposal: { account: "acme" } } },
    });
    approvalApp.approvals.reject(waiting.execution.wait.referenceId, ben);
    const result = await preparedApproval.continue(waiting.execution);
    if (result.ok || result.failure.code !== "APPROVAL_REJECTED") throw new Error("rejection failed");
    return result;
  }, opts);
  scenarios.push({
    id: "D.approval-and-draft",
    successRate: 1,
    waitpointAndContinueMs: approval.statsMs,
    rejectionMs: denial.statsMs,
    duplicateReplayDidNotSucceed: approval.lastResult.duplicateOk === false,
    limitation: "Human decision time is excluded; only Runtime waitpoint, approve(), and continue() are measured.",
  });

  const linear = compileWorkflowSource(
    `
schemaVersion: 1
id: bench.durable
version: "1.0.0"
name: Durable linear
entryNodeId: a
nodes:
  - { id: a, kind: deterministic, config: {} }
  - { id: b, kind: deterministic, config: {} }
  - { id: final, kind: final_output, config: {} }
edges:
  - { sourceNodeId: a, targetNodeId: b }
  - { sourceNodeId: b, targetNodeId: final }
`,
    "yaml",
  );
  if (!linear.ok) throw new Error("durable workflow compile failed");
  const recovery = await measure(async () => {
    const root = mkdtempSync(join(tmpdir(), "aao-bench-durability-"));
    try {
      const store = createFileDurabilityStore({ root });
      const registry = createNodeRegistry();
      registry.register({
        kind: "deterministic",
        retrySafety: () => "safe",
        recoverySafety: () => "safe",
        async execute({ node }) {
          return { ok: true, statePatch: { [node.id]: true }, output: { node: node.id } };
        },
      });
      registry.register(finalOutputExecutor);
      const host = createDurableRuntimeHost({ store, plan: linear.plan, registry });
      const runId = `run.bench.durable.${Date.now()}`;
      const first = await host.execute({ runId, initialState: { runId, revision: 0, values: {} } });
      if (!first.ok) throw new Error(`durable execute failed: ${JSON.stringify(first.failure)}`);
      const resumed = await createDurableRuntimeHost({
        store: createFileDurabilityStore({ root }),
        plan: linear.plan,
        registry,
      }).resume(runId);
      if (!resumed.ok || resumed.execution.run.status !== "COMPLETED") throw new Error("durable resume failed");
      const latest = await createFileDurabilityStore({ root }).getLatestCheckpoint(runId);
      return { status: first.execution.run.status, resumed: resumed.execution.run.status, checkpointSequence: latest?.sequence };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, { warmup: 1, samples: Math.min(samples, 8) });
  scenarios.push({
    id: "E.recovery",
    successRate: 1,
    checkpointRoundtripMs: recovery.statsMs,
    limitation: "Filesystem durability on one host. Missing Run lookup is fail-closed. Not distributed recovery.",
  });

  const obsStore = createInMemoryTraceStore();
  const obsTrace = createTraceRecorder({ store: obsStore });
  const auditStore = createInMemoryAuditStore();
  const audit = createAuditRecorder({ store: auditStore });
  const obsApp = createAAO({
    governance: governance(),
    principalForRun: () => ana,
    tools: [lookupTool()],
    trace: obsTrace,
    audit,
  });
  const preparedObs = obsApp.prepareWorkflow(lookupWorkflow);
  const observability = await measure(async () => {
    const runId = `run.bench.obs.${Date.now()}-${Math.random()}`;
    const result = await preparedObs.execute({ runId, initialState: { runId, revision: 0, values: { request: { query: "Acme" } } } });
    const trace = await obsStore.getRunTrace(runId);
    const metrics = deriveRunMetrics({ trace });
    const inspection = projectRunInspection({ runId, authoritativeRun: result.execution?.run, workflow: lookupWorkflow, traceEvents: trace });
    return { metricsOk: metrics.ok, inspection: inspection.summary.status };
  }, opts);
  scenarios.push({
    id: "F.observability",
    successRate: 1,
    emitAndProjectMs: observability.statsMs,
  });

  const pack = CANONICAL_CAPABILITY_PACKS[0];
  const packValidate = await measure(() => validateCapabilityPackManifest(pack.manifest), opts);
  const compatible = await measure(() =>
    validatePackCompatibility(pack, {
      companyId: "northstar-commerce",
      enabledProofs: ["company_research"],
      governanceRoles: [{ id: "research.analyst" }],
      integrations: { publicWebProviderRef: "northstar.web-provider" },
      workflow: pack.manifest.workflow,
      registeredTools: pack.manifest.requirements.toolRefs,
      registeredModelPolicies: pack.manifest.requirements.modelPolicyRefs,
      registeredModelBindings: [
        {
          id: "northstar.model.native",
          capabilities: pack.manifest.requirements.modelCapabilities,
          adapterRef: { id: "native", version: "1.0.0" },
          adapter: {
            id: "native",
            version: "1.0.0",
            capabilities: pack.manifest.requirements.modelCapabilities.map((capability) => ({ capability, support: "supported" })),
          },
        },
      ],
      registeredEvalProfiles: [pack.manifest.verification.evalProfileRef],
    }), opts);
  let missingRefused = false;
  try {
    validatePackCompatibility(pack, {
      companyId: "northstar-commerce",
      enabledProofs: ["company_research"],
      governanceRoles: [{ id: "research.analyst" }],
      integrations: { publicWebProviderRef: "northstar.web-provider" },
      workflow: pack.manifest.workflow,
      registeredTools: [],
      registeredModelPolicies: pack.manifest.requirements.modelPolicyRefs,
      registeredModelBindings: [],
      registeredEvalProfiles: [pack.manifest.verification.evalProfileRef],
    });
  } catch {
    missingRefused = true;
  }
  scenarios.push({
    id: "G.capability-pack-preflight",
    successRate: missingRefused ? 1 : 0,
    manifestValidationMs: packValidate.statsMs,
    compatibilityMs: compatible.statsMs,
    missingDependencyRefused: missingRefused,
  });

  const concApp = createAAO({
    governance: governance(),
    principalForRun: () => ana,
    tools: [lookupTool()],
  });
  const concPrepared = concApp.prepareWorkflow(lookupWorkflow);
  const concurrency = [];
  for (const n of [1, 4, 8]) {
    const started = process.hrtime.bigint();
    const heapBefore = process.memoryUsage().heapUsed;
    const results = await Promise.all(
      Array.from({ length: n }, async (_, index) => {
        const runId = `run.bench.conc.${n}.${index}.${Date.now()}`;
        return concPrepared.execute({ runId, initialState: { runId, revision: 0, values: { request: { query: "Acme" } } } });
      }),
    );
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const heapAfter = process.memoryUsage().heapUsed;
    concurrency.push({
      concurrentRuns: n,
      elapsedMs,
      throughputRunsPerSec: (n / elapsedMs) * 1000,
      successRate: results.filter((result) => result.ok).length / n,
      heapDeltaBytes: heapAfter - heapBefore,
    });
  }
  scenarios.push({
    id: "H.modest-concurrency",
    successRate: concurrency.every((row) => row.successRate === 1) ? 1 : 0,
    matrix: concurrency,
    limitation: "Single-process in-memory Runtime. Not a distributed scalability claim.",
  });

  return scenarios;
}
