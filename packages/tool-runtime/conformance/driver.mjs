// Native AAO Tool substrate — adapter verification driver (Sprint 18, ADR-023).
//
// Test-owned, never production code: it lives with the substrate it drives
// (the Tool Runtime with a trusted local handler) and turns a canonical
// scenario into canonical AAO evidence by running a real compiled AAO
// workflow with the real Trace and Audit recorders, which the verification
// host injects (`recorders`: the canonical @aao/observability factories), so
// the Tool Runtime takes no dependency on the evidence layer. It imports
// nothing from @aao/evaluation; the verifier judges the evidence it returns.
// This is the semantic reference other Tool substrates are compared against.
import { createNodeRegistry, executeWorkflow, finalOutputExecutor } from '@aao/runtime';
import { createToolNodeExecutor, createToolRegistry } from '@aao/tool-runtime';
import { compileWorkflowSource } from '@aao/workflow-dsl';

const clockFrom = (offset) => {
  let tick = offset;
  return { now: () => new Date(Date.UTC(2026, 9, 13, 9, 0, 0) + 1000 * tick++).toISOString() };
};

/** read (Tool) → final, built from the scenario's canonical parameters only. */
export function toolWorkflowPlan(parameters, workflowId) {
  const compiled = compileWorkflowSource(JSON.stringify({
    schemaVersion: 1, id: workflowId, version: '1.0.0', name: 'Adapter conformance Tool workflow', entryNodeId: 'read',
    nodes: [
      { id: 'read', kind: 'tool', config: { toolRef: parameters.toolRef, inputStateKey: parameters.inputStateKey, resultStateKey: parameters.resultStateKey } },
      { id: 'final', kind: 'final_output', config: {} },
    ],
    edges: [{ sourceNodeId: 'read', targetNodeId: 'final' }],
  }), 'json');
  if (!compiled.ok) throw new Error('conformance workflow did not compile');
  return compiled.plan;
}

/**
 * Run one Tool scenario through the real Runtime + Tool Runtime with any
 * registered Tool (local handler or a substrate binding) and return
 * canonical evidence: Trace, execution state, and Audit.
 */
export async function runToolScenario({ scenario, registeredTool, runId, workflowId, recorders }) {
  const parameters = scenario.parameters;
  const traceStore = recorders.createInMemoryTraceStore();
  const trace = recorders.createTraceRecorder({ store: traceStore, clock: clockFrom(0) });
  const auditStore = recorders.createInMemoryAuditStore();
  const audit = recorders.createAuditRecorder({ store: auditStore, clock: clockFrom(500) });
  const tools = createToolRegistry();
  tools.register(registeredTool);
  const nodes = createNodeRegistry();
  nodes.register(createToolNodeExecutor({ tools, resolveAuthorizationContext: () => ({ schemaVersion: 1, principal: parameters.principal, grantedPermissionClasses: parameters.grantedPermissionClasses }), audit }));
  nodes.register(finalOutputExecutor);
  const options = {
    clock: clockFrom(0),
    sleeper: { sleep: async () => undefined },
    trace,
    ...(parameters.maxAttempts ? { reliability: { policiesByNodeId: { read: { maxAttempts: parameters.maxAttempts } } } } : {}),
  };
  const result = await executeWorkflow({ runId, plan: toolWorkflowPlan(parameters, workflowId), registry: nodes, initialState: { runId, revision: 0, values: { [parameters.inputStateKey]: parameters.input } }, options });
  await audit.flush();
  return { origin: 'live_run', runId, trace: await traceStore.getRunTrace(runId), execution: result.execution, audit: await auditStore.getStream(`run:${runId}`) };
}

export function toolSpec(parameters) {
  return {
    schemaVersion: 1, ...parameters.toolRef, name: 'Read account', description: 'Host policy',
    inputSchema: { type: 'object', properties: { accountId: { type: 'string', minLength: 1 } }, required: ['accountId'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id', 'name'], additionalProperties: false },
    permissionClasses: parameters.permissionClasses,
  };
}

/** The native AAO Tool driver: a trusted local handler registered with the Tool Runtime. */
export function createNativeToolDriver({ recorders }) {
  let handlerCalls = 0;
  return Object.freeze({
    id: 'aao.native-tool',
    kind: 'tool',
    support: Object.freeze({
      'tool.success-structured-result': 'SUPPORTED',
      'tool.unauthorized-blocked': 'SUPPORTED',
      'tool.unsupported-permission-blocked': 'SUPPORTED',
      'tool.failure-normalized': 'SUPPORTED',
      // A local handler can declare itself retry-safe, so the Runtime may retry it.
      'tool.transient-retry': 'SUPPORTED',
    }),
    sensitiveMarkers: Object.freeze([]),
    handlerCalls: () => handlerCalls,
    async executeScenario(scenario) {
      const parameters = scenario.parameters;
      let calls = 0;
      const handler = {
        async execute({ input }) {
          calls += 1;
          handlerCalls += 1;
          if (scenario.id === 'tool.failure-normalized') return { ok: false, code: 'HANDLER_REPORTED_ERROR' };
          if (scenario.id === 'tool.transient-retry' && calls === 1) return { ok: false, code: 'UPSTREAM_UNAVAILABLE', retryable: true };
          return { ok: true, output: { id: input.accountId, name: parameters.expectedOutput.name } };
        },
      };
      // AAO permits a retry-safe declaration only for read_only Tools; the driver never claims more.
      const readOnly = parameters.permissionClasses.every((permission) => permission === 'read_only');
      return runToolScenario({ scenario, registeredTool: { spec: toolSpec(parameters), ...(readOnly ? { retrySafety: 'safe' } : {}), handler }, runId: `run.conformance.native-tool.${scenario.id}`, workflowId: 'conformance.tool', recorders });
    },
  });
}
