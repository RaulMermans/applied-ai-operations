// Shared AAO host for model-substrate verification drivers (Sprint 18, ADR-023).
// Test-owned, never production code. One canonical workflow (answer: model
// → final) with the real Model Runtime, Runtime, and Trace recorder; only
// the injected ModelAdapter differs between substrates. The verification
// host injects the canonical recorders (the @aao/observability factories),
// so the Model Runtime takes no dependency on the evidence layer. Imports
// nothing from @aao/evaluation.
import { createModelNodeExecutor, createModelPolicyRegistry, createModelRegistry } from '@aao/model-runtime';
import { createNodeRegistry, executeWorkflow, finalOutputExecutor } from '@aao/runtime';
import { compileWorkflowSource } from '@aao/workflow-dsl';

const clockFrom = (offset) => {
  let tick = offset;
  return { now: () => new Date(Date.UTC(2026, 9, 13, 10, 0, 0) + 1000 * tick++).toISOString() };
};

/** A canonical ModelRequest built from scenario parameters — never a provider payload. */
export function modelRequest(parameters) {
  return {
    schemaVersion: 1,
    invocationId: 'inv.conformance.1',
    messages: [{ role: 'user', content: 'Classify: quarterly market study.' }],
    output: parameters.outputKind === 'structured' ? { kind: 'structured', schema: parameters.structuredSchema, name: 'classification' } : { kind: 'text' },
  };
}

export async function runModelScenario({ scenario, adapter, runId, recorders }) {
  const parameters = scenario.parameters;
  const compiled = compileWorkflowSource(JSON.stringify({
    schemaVersion: 1, id: 'conformance.model', version: '1.0.0', name: 'Adapter conformance model workflow', entryNodeId: 'answer',
    nodes: [
      { id: 'answer', kind: 'model', config: { modelPolicyRef: parameters.modelPolicyRef, requestStateKey: parameters.requestStateKey, resultStateKey: parameters.resultStateKey } },
      { id: 'final', kind: 'final_output', config: {} },
    ],
    edges: [{ sourceNodeId: 'answer', targetNodeId: 'final' }],
  }), 'json');
  if (!compiled.ok) throw new Error('conformance model workflow did not compile');
  const models = createModelRegistry();
  // Trusted registration identity: the only source of model identity in AAO evidence.
  models.register({ id: parameters.modelBindingId, priority: 10, capabilities: ['model.text_generation', 'model.structured_output'], identity: parameters.identity, adapter });
  const policies = createModelPolicyRegistry();
  policies.register({ schemaVersion: 1, id: parameters.modelPolicyRef, version: '1.0.0', name: 'Conformance model policy' });
  const nodes = createNodeRegistry();
  nodes.register(createModelNodeExecutor({ models, policies }));
  nodes.register(finalOutputExecutor);
  const traceStore = recorders.createInMemoryTraceStore();
  const trace = recorders.createTraceRecorder({ store: traceStore, clock: clockFrom(0) });
  const options = {
    clock: clockFrom(0),
    // Deterministic delay boundary: an attempt timeout fires as soon as the Runtime arms it.
    sleeper: { sleep: async () => undefined },
    trace,
    ...(parameters.attemptTimeoutMs ? { reliability: { policiesByNodeId: { answer: { maxAttempts: 1, attemptTimeoutMs: parameters.attemptTimeoutMs } } } } : {}),
  };
  const result = await executeWorkflow({ runId, plan: compiled.plan, registry: nodes, initialState: { runId, revision: 0, values: { [parameters.requestStateKey]: modelRequest(parameters) } }, options });
  return { origin: 'live_run', runId, trace: await traceStore.getRunTrace(runId), execution: result.execution };
}
