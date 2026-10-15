// The canonical conformance host (Sprint 20, ADR-025): it turns one
// canonical scenario plus one subject (the adapter under test) into
// canonical AAO evidence by running a real compiled AAO workflow through
// the real Runtime, Tool Runtime or Model Runtime, Authorization, and the
// canonical Trace and Audit recorders. Only the substrate differs between
// subjects. The scenario, the workflow, and all host configuration come
// from here, never from the subject.
import type { AdapterConformanceScenario, AdapterManifest } from "@aao/adapters";
import type { PermissionClass, Principal, RetrySafety, ToolSpec } from "@aao/contracts";
import type { AdapterConformanceDriver, AdapterScenarioExecution } from "@aao/evaluation";
import { createModelNodeExecutor, createModelPolicyRegistry, createModelRegistry, type ModelAdapter } from "@aao/model-runtime";
import { createAuditRecorder, createInMemoryAuditStore, createInMemoryTraceStore, createTraceRecorder } from "@aao/observability";
import { createNodeRegistry, executeWorkflow, finalOutputExecutor } from "@aao/runtime";
import { createToolNodeExecutor, createToolRegistry, type RegisteredTool } from "@aao/tool-runtime";
import { compileWorkflowSource } from "@aao/workflow-dsl";

/** A model adapter under test: its manifest, what it seeds that must never leak, and a fresh adapter per scenario. */
export interface ModelConformanceSubject {
  readonly manifest: AdapterManifest;
  readonly sensitiveMarkers?: readonly string[];
  prepare(scenario: AdapterConformanceScenario): { adapter: ModelAdapter; observations(): { cancellationObserved: boolean } };
}

/** What the host decided for one Tool: the subject must bind exactly this spec with exactly this retry safety. */
export interface ToolProviderHostBinding {
  spec: ToolSpec;
  retrySafety: RetrySafety;
}

/** A Tool-provider adapter under test: it supplies a canonical `RegisteredTool` for the host's binding, and nothing else. */
export interface ToolProviderConformanceSubject {
  readonly manifest: AdapterManifest;
  readonly sensitiveMarkers?: readonly string[];
  prepare(scenario: AdapterConformanceScenario, host: ToolProviderHostBinding): Promise<{ tool: RegisteredTool; dispose(): Promise<void> }>;
}

export type AdapterConformanceSubject = ModelConformanceSubject | ToolProviderConformanceSubject;

interface ToolParameters {
  toolRef: { id: string; version: string };
  permissionClasses: PermissionClass[];
  principal: Principal;
  grantedPermissionClasses: PermissionClass[];
  input: Record<string, unknown>;
  inputStateKey: string;
  resultStateKey: string;
  hostRetrySafety?: RetrySafety;
  maxAttempts?: number;
}

interface ModelParameters {
  modelPolicyRef: string;
  modelBindingId: string;
  identity: { provider: string; model: string };
  requestStateKey: string;
  resultStateKey: string;
  outputKind: "text" | "structured";
  structuredSchema: Record<string, unknown>;
  attemptTimeoutMs?: number;
}

const clockFrom = (offset: number) => {
  let tick = offset;
  return { now: () => new Date(Date.UTC(2026, 9, 13, 9, 0, 0) + 1000 * tick++).toISOString() };
};
// Deterministic delay boundary: an attempt timeout fires on the next macrotask, once every pending
// microtask has run. The provider call has then genuinely started and blocks, so cancellation is
// observed at the provider boundary, not short-circuited before the call. No wall-clock time is involved.
const immediate = { sleep: () => new Promise<void>((resolve) => setImmediate(resolve)) };

function compileScenarioWorkflow(source: object) {
  const compiled = compileWorkflowSource(JSON.stringify(source), "json");
  if (!compiled.ok) throw new Error("conformance workflow did not compile");
  return compiled.plan;
}

/** The host-owned canonical ToolSpec for a Tool scenario. No subject or remote metadata contributes to it. */
export function conformanceToolSpec(parameters: ToolParameters): ToolSpec {
  return {
    schemaVersion: 1, ...parameters.toolRef, name: "Read account", description: "Host policy",
    inputSchema: { type: "object", properties: { accountId: { type: "string", minLength: 1 } }, required: ["accountId"], additionalProperties: false },
    outputSchema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id", "name"], additionalProperties: false },
    permissionClasses: parameters.permissionClasses,
  };
}

/** read (Tool) → final, with the scenario's principal, grants, and reliability policy. */
async function runToolScenario(scenario: AdapterConformanceScenario, tool: RegisteredTool, runId: string): Promise<AdapterScenarioExecution> {
  const parameters = scenario.parameters as unknown as ToolParameters;
  const traceStore = createInMemoryTraceStore();
  const trace = createTraceRecorder({ store: traceStore, clock: clockFrom(0) });
  const auditStore = createInMemoryAuditStore();
  const audit = createAuditRecorder({ store: auditStore, clock: clockFrom(500) });
  const tools = createToolRegistry();
  tools.register(tool);
  const nodes = createNodeRegistry();
  nodes.register(createToolNodeExecutor({ tools, resolveAuthorizationContext: () => ({ schemaVersion: 1, principal: parameters.principal, grantedPermissionClasses: parameters.grantedPermissionClasses }), audit }));
  nodes.register(finalOutputExecutor);
  const plan = compileScenarioWorkflow({
    schemaVersion: 1, id: "conformance.tool", version: "1.0.0", name: "Adapter conformance Tool workflow", entryNodeId: "read",
    nodes: [
      { id: "read", kind: "tool", config: { toolRef: parameters.toolRef, inputStateKey: parameters.inputStateKey, resultStateKey: parameters.resultStateKey } },
      { id: "final", kind: "final_output", config: {} },
    ],
    edges: [{ sourceNodeId: "read", targetNodeId: "final" }],
  });
  const options = { clock: clockFrom(0), sleeper: immediate, trace, ...(parameters.maxAttempts ? { reliability: { policiesByNodeId: { read: { maxAttempts: parameters.maxAttempts } } } } : {}) };
  const result = await executeWorkflow({ runId, plan, registry: nodes, initialState: { runId, revision: 0, values: { [parameters.inputStateKey]: parameters.input as never } }, options });
  await audit.flush();
  return { evidence: { origin: "live_run", runId, trace: (await traceStore.getRunTrace(runId)) as never, execution: result.execution as never, audit: (await auditStore.getStream(`run:${runId}`)) as never } };
}

/** answer (model) → final, with the binding identity and timeout the scenario prescribes. */
async function runModelScenario(scenario: AdapterConformanceScenario, adapter: ModelAdapter, runId: string): Promise<AdapterScenarioExecution["evidence"]> {
  const parameters = scenario.parameters as unknown as ModelParameters & { structuredOutput?: unknown };
  const models = createModelRegistry();
  // Trusted registration identity: the only source of model identity in AAO evidence.
  models.register({ id: parameters.modelBindingId, priority: 10, capabilities: ["model.text_generation", "model.structured_output"], identity: parameters.identity, adapter });
  const policies = createModelPolicyRegistry();
  policies.register({ schemaVersion: 1, id: parameters.modelPolicyRef, version: "1.0.0", name: "Conformance model policy" });
  const nodes = createNodeRegistry();
  nodes.register(createModelNodeExecutor({ models, policies }));
  nodes.register(finalOutputExecutor);
  const traceStore = createInMemoryTraceStore();
  const trace = createTraceRecorder({ store: traceStore, clock: clockFrom(0) });
  const plan = compileScenarioWorkflow({
    schemaVersion: 1, id: "conformance.model", version: "1.0.0", name: "Adapter conformance model workflow", entryNodeId: "answer",
    nodes: [
      { id: "answer", kind: "model", config: { modelPolicyRef: parameters.modelPolicyRef, requestStateKey: parameters.requestStateKey, resultStateKey: parameters.resultStateKey } },
      { id: "final", kind: "final_output", config: {} },
    ],
    edges: [{ sourceNodeId: "answer", targetNodeId: "final" }],
  });
  const request = {
    schemaVersion: 1,
    invocationId: "inv.conformance.1",
    messages: [{ role: "user", content: "Classify: quarterly market study." }],
    output: parameters.outputKind === "structured" ? { kind: "structured", schema: parameters.structuredSchema, name: "classification" } : { kind: "text" },
  };
  const options = { clock: clockFrom(0), sleeper: immediate, trace, ...(parameters.attemptTimeoutMs ? { reliability: { policiesByNodeId: { answer: { maxAttempts: 1, attemptTimeoutMs: parameters.attemptTimeoutMs } } } } : {}) };
  const result = await executeWorkflow({ runId, plan, registry: nodes, initialState: { runId, revision: 0, values: { [parameters.requestStateKey]: request as never } }, options });
  return { origin: "live_run", runId, trace: (await traceStore.getRunTrace(runId)) as never, execution: result.execution as never };
}

const isToolSubject = (subject: AdapterConformanceSubject): subject is ToolProviderConformanceSubject => subject.manifest.kind === "tool_provider";

/**
 * The driver the Evaluation Runtime calls: one fresh subject preparation per
 * scenario, the canonical harness for the subject's kind, and the subject's
 * boundary observation. Tool resources are always disposed.
 */
export function createConformanceDriver(subject: AdapterConformanceSubject): AdapterConformanceDriver {
  const slug = subject.manifest.id.replace(/[^a-zA-Z0-9]+/g, "-");
  return Object.freeze({
    sensitiveMarkers: Object.freeze([...(subject.sensitiveMarkers ?? [])]),
    async executeScenario(scenario: AdapterConformanceScenario): Promise<AdapterScenarioExecution> {
      const runId = `run.conformance.${slug}.${scenario.id}`;
      if (isToolSubject(subject)) {
        const parameters = scenario.parameters as unknown as ToolParameters;
        const prepared = await subject.prepare(scenario, { spec: conformanceToolSpec(parameters), retrySafety: parameters.hostRetrySafety ?? "unsafe" });
        try {
          return await runToolScenario(scenario, prepared.tool, runId);
        } finally {
          await prepared.dispose();
        }
      }
      if (subject.manifest.kind !== "model") throw new Error(`no canonical conformance harness for ${subject.manifest.kind} adapters`);
      const prepared = (subject as ModelConformanceSubject).prepare(scenario);
      const evidence = await runModelScenario(scenario, prepared.adapter, runId);
      return { evidence, boundary: { cancellationObserved: prepared.observations().cancellationObserved } };
    },
  });
}
