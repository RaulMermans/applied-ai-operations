// Sprint 20 compiled smoke: the adapter and portability contract, using
// compiled package output only (run after `pnpm build`). Every import
// resolves to dist/ through package exports. No repository-relative
// adapter driver, no network, no credentials, no live provider.
//
//  1. Adapter manifests validate (official adapters and native references).
//  2. Native and Vercel AI SDK model adapters register with createAAO.
//  3. Native and MCP Tool paths register.
//  4. The same portable Workflow runs through alternate bindings.
//  5. Semantic Evals agree.
//  6. Cancellation reaches the Vercel / fake provider boundary.
//  7. Host-owned MCP retry safety permits one bounded safe retry.
//  8. Hostile remote metadata cannot enable retry or authority.
//  9. An unsupported side-effect class remains blocked.
// 10. Continuation returns a new execution without mutating its input.
// 11. The generated compatibility matrix reflects real conformance.
// 12. Anti-self-attestation: an empty or partial conformance report is
//     intact but never a full PASS; a real complete official report is.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { ADAPTER_CONFORMANCE_SCENARIOS, ADAPTER_CONFORMANCE_SUITE, adapterConformancePassed, buildAdapterConformanceReport, validateAdapterConformanceReportIntegrity, validateAdapterManifest, validateCompleteAdapterConformanceReport } from '@aao/adapters';
import { buildEvalComparisonKey, createEvaluatorRegistry, deterministicGraders, runEvalDataset, semanticVerdictFingerprint } from '@aao/evaluation';
import { MCP_CONNECTOR_ADAPTER_MANIFEST, createMcpSession, createMcpToolBinding } from '@aao/mcp-connector';
import { createMcpConformanceSubject } from '@aao/mcp-connector/conformance';
import { VERCEL_AI_SDK_ADAPTER_MANIFEST } from '@aao/model-runtime/vercel-ai';
import { createVercelAiConformanceSubject } from '@aao/model-runtime/vercel-ai/conformance';
import { createInMemoryTraceStore, createTraceRecorder } from '@aao/observability';
import { createAAO, defineModelAdapter, defineTool } from '../dist/index.js';
import { NATIVE_MODEL_REFERENCE_MANIFEST, NATIVE_TOOL_REFERENCE_MANIFEST, createConformanceDriver, nativeToolReference, verifyAdapterConformance } from '../dist/conformance/index.js';
import { runAdaptersMatrix } from '../dist/cli/eval/adapters.js';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = join(packageRoot, '..', '..');
const MCP_SERVER = join(repositoryRoot, 'packages', 'mcp-connector', 'conformance', 'server.mjs');
const scenario = (id) => ADAPTER_CONFORMANCE_SCENARIOS.find((entry) => entry.id === id);
const alice = { id: 'user.alice', type: 'user' };
const bob = { id: 'user.bob', type: 'user' };
const governance = {
  actors: [alice, bob],
  roles: [{ id: 'operator', version: '1.0.0', permissionClasses: ['read_only', 'write_draft', 'external_side_effect'] }, { id: 'manager', version: '1.0.0', permissionClasses: ['read_only', 'write_draft'] }],
  bindings: [{ id: 'alice.operator', actorId: alice.id, roleId: 'operator', status: 'active' }, { id: 'bob.manager', actorId: bob.id, roleId: 'manager', status: 'active' }],
  policies: [],
};
const clockAt = () => { let tick = 0; return { now: () => new Date(Date.UTC(2026, 9, 14, 6, 0, tick++)).toISOString() }; };
const sessions = [];

// --- 1. Manifests validate. ---
for (const manifest of [MCP_CONNECTOR_ADAPTER_MANIFEST, VERCEL_AI_SDK_ADAPTER_MANIFEST, NATIVE_MODEL_REFERENCE_MANIFEST, NATIVE_TOOL_REFERENCE_MANIFEST]) {
  assert(validateAdapterManifest(JSON.parse(JSON.stringify(manifest))).ok, `manifest ${manifest.id} does not validate`);
}
assert(MCP_CONNECTOR_ADAPTER_MANIFEST.kind === 'tool_provider', 'MCP must be a tool_provider');
assert(!validateAdapterManifest({ ...VERCEL_AI_SDK_ADAPTER_MANIFEST, permissions: ['destructive'] }).ok, 'a manifest granting permissions validated');

// --- 2–5. One portable Workflow, alternate bindings, same semantics. ---
const ACCOUNT_SPEC = {
  schemaVersion: 1, id: 'crm.account.read', version: '1.0.0', name: 'Read account',
  inputSchema: { type: 'object', properties: { accountId: { type: 'string', minLength: 1 } }, required: ['accountId'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id', 'name'], additionalProperties: false },
  permissionClasses: ['read_only'],
};
const CATEGORY_SCHEMA = { type: 'object', properties: { category: { type: 'string', enum: ['research', 'sales', 'support'] } }, required: ['category'], additionalProperties: false };
const PORTABLE = {
  schemaVersion: 1, id: 'research.classify-and-read', version: '1.0.0', name: 'Classify and read', entryNodeId: 'prepare',
  nodes: [
    { id: 'prepare', kind: 'deterministic', config: { executorRef: { id: 'classify.prepare-request', version: '1.0.0' } } },
    { id: 'classify', kind: 'model', config: { modelPolicyRef: 'policy.classification', requestStateKey: 'classificationRequest', resultStateKey: 'classification' } },
    { id: 'approve', kind: 'approval', config: { subjectStateKey: 'accountRequest', permissionClasses: ['read_only'], requiredApproverRoleIds: ['manager'] } },
    { id: 'read', kind: 'tool', config: { toolRef: { id: 'crm.account.read', version: '1.0.0' }, inputStateKey: 'accountRequest', resultStateKey: 'account' } },
    { id: 'final', kind: 'final_output', config: {} },
  ],
  edges: [{ sourceNodeId: 'prepare', targetNodeId: 'classify' }, { sourceNodeId: 'classify', targetNodeId: 'approve' }, { sourceNodeId: 'approve', targetNodeId: 'read' }, { sourceNodeId: 'read', targetNodeId: 'final' }],
};
assert(!/vercel|mcp|openai|langgraph/i.test(JSON.stringify(PORTABLE)), 'the portable Workflow names a vendor');
const prepareRequest = {
  id: 'classify.prepare-request', version: '1.0.0',
  async execute({ state }) {
    return { ok: true, statePatch: { classificationRequest: { schemaVersion: 1, invocationId: 'inv.smoke', messages: [{ role: 'user', content: `Classify ${state.values.company}.` }], output: { kind: 'structured', schema: CATEGORY_SCHEMA, name: 'classification' } }, accountRequest: { accountId: String(state.values.company) } } };
  },
};

async function runPortable({ model, tool, adapterRef }) {
  const clock = clockAt();
  const store = createInMemoryTraceStore();
  const app = createAAO({
    governance, principalForRun: () => alice, tools: [tool], modelAdapters: [model],
    modelBindings: [{ id: 'classifier', priority: 10, capabilities: ['model.text_generation', 'model.structured_output'], identity: { provider: 'portable', model: 'classifier' }, adapterRef }],
    modelPolicies: [{ schemaVersion: 1, id: 'policy.classification', version: '1.0.0', name: 'Classification' }],
    deterministicExecutors: [prepareRequest], trace: createTraceRecorder({ store, clock }), clock,
  });
  const prepared = app.prepareWorkflow(PORTABLE);
  const waiting = await prepared.execute({ runId: 'run.smoke', initialState: { runId: 'run.smoke', revision: 0, values: { company: 'a-1' } } });
  assert(waiting.execution.run.status === 'WAITING_FOR_APPROVAL', 'portable Run did not wait for Approval');
  app.approvals.approve(waiting.execution.wait.referenceId, bob);
  const input = JSON.stringify(waiting.execution);
  const done = await prepared.continue(waiting.execution);
  // --- 10. Continuation is non-mutating. ---
  assert(JSON.stringify(waiting.execution) === input && done.execution !== waiting.execution, 'continuation mutated its input execution');
  assert(done.ok && done.execution.run.status === 'COMPLETED', `portable Run did not complete: ${JSON.stringify(done.failure)}`);
  return { planFingerprint: prepared.planFingerprint, done, trace: await store.getRunTrace('run.smoke') };
}

const nativeModel = defineModelAdapter({
  manifest: { id: 'host.native-model', version: '1.0.0', kind: 'model', capabilities: [{ capability: 'model.text_generation', support: 'supported' }, { capability: 'model.structured_output', support: 'supported' }, { capability: 'model.usage', support: 'supported' }, { capability: 'model.cancellation', support: 'unsupported' }, { capability: 'model.tool_call_response', support: 'unsupported' }] },
  adapter: { invoke: async () => ({ status: 'succeeded', output: { category: 'research' }, finishReason: 'stop', usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 } }) },
});
const nativeTool = defineTool({ spec: ACCOUNT_SPEC, handler: { execute: async ({ input }) => ({ ok: true, output: { id: input.accountId, name: 'Local Test Account' } }) } });
const a = await runPortable({ model: nativeModel, tool: nativeTool, adapterRef: { id: 'host.native-model', version: '1.0.0' } });

const vercelModel = defineModelAdapter({ manifest: VERCEL_AI_SDK_ADAPTER_MANIFEST, adapter: createVercelAiConformanceSubject().prepare(scenario('model.structured-output')).adapter });
const mcpSession = createMcpSession({ command: process.execPath, args: [MCP_SERVER, JSON.stringify({ outcomes: ['success'], hostile: true })] });
sessions.push(mcpSession);
await mcpSession.connect();
const mcpTool = defineTool(await createMcpToolBinding({ session: mcpSession, remoteToolName: 'crm.read_account', spec: ACCOUNT_SPEC }));
const b = await runPortable({ model: vercelModel, tool: mcpTool, adapterRef: { id: 'aao.vercel-ai-sdk', version: '1.0.0' } });

assert(a.planFingerprint === b.planFingerprint, 'alternate bindings changed the Workflow identity');
const trajectory = (run) => run.done.execution.history.map((record) => `${record.nodeId}:${record.status}`).join(',');
assert(trajectory(a) === trajectory(b), 'alternate bindings changed the node trajectory');
const definitions = [
  { schemaVersion: 2, id: 'smoke.completed', version: '1.0.0', name: 'completed', categories: ['capability'], supportedModes: ['RUNTIME'], targetType: 'run', graderRef: { id: 'aao.run-outcome', version: '1.0.0' }, config: { expectedStatus: 'COMPLETED' } },
  { schemaVersion: 2, id: 'smoke.trajectory', version: '1.0.0', name: 'trajectory', categories: ['capability'], supportedModes: ['RUNTIME'], targetType: 'run', graderRef: { id: 'aao.trajectory', version: '1.0.0' }, config: { nodeSequence: { mode: 'exact', nodes: ['prepare', 'classify', 'approve', 'read', 'final'] } } },
  { schemaVersion: 2, id: 'smoke.approval', version: '1.0.0', name: 'approval', categories: ['capability'], supportedModes: ['RUNTIME'], targetType: 'approval', graderRef: { id: 'aao.approval-compliance', version: '2.0.0' }, config: { approvalRequired: true, expectedResolution: 'approved', guardApprovalNodeId: 'approve', noToolBeforeApproval: true } },
  { schemaVersion: 2, id: 'smoke.model-call', version: '1.0.0', name: 'model call', categories: ['capability'], supportedModes: ['RUNTIME'], targetType: 'run', graderRef: { id: 'aao.model-call', version: '1.0.0' }, config: { expectedCalls: { min: 1, max: 1 }, expectedOutcome: 'completed' } },
];
const dataset = { schemaVersion: 2, id: 'smoke.portable', version: '1.0.0', name: 'portable', cases: definitions.map((entry) => ({ id: `${entry.id}.001`, evalRef: { id: entry.id, version: '1.0.0' }, mode: 'RUNTIME', evidenceRef: 'run://smoke', expected: { status: 'passed' } })) };
const verdicts = async (run) => {
  const evidence = { origin: 'live_run', runId: 'run.smoke', trace: run.trace, execution: run.done.execution };
  const judged = await runEvalDataset({ dataset, definitions, registry: createEvaluatorRegistry(deterministicGraders()), evidenceResolver: { resolve: (ref) => (ref === 'run://smoke' ? evidence : undefined) } });
  assert(judged.ok, 'portable Evals did not run');
  return judged.run.cases.map((entry) => `${entry.result.status}:${buildEvalComparisonKey(entry.result)}:${semanticVerdictFingerprint(entry.result)}`);
};
const verdictsA = await verdicts(a);
assert(verdictsA.every((entry) => entry.startsWith('passed:')), `native configuration failed an Eval: ${verdictsA}`);
assert(JSON.stringify(verdictsA) === JSON.stringify(await verdicts(b)), 'semantic Eval verdicts diverged across bindings');

// --- 6. Cancellation reaches the provider boundary. ---
const vercelSubject = createVercelAiConformanceSubject();
let cancellation;
const cancelled = await createConformanceDriver({ manifest: vercelSubject.manifest, prepare: (target) => { const prepared = vercelSubject.prepare(target); return { adapter: prepared.adapter, observations: () => (cancellation = prepared.observations()) }; } }).executeScenario(scenario('model.cancellation-propagated'));
assert(cancellation.cancellationObserved === true && cancellation.providerCalls === 1, 'the Vercel provider did not observe cancellation');
assert(cancelled.evidence.execution.run.status === 'FAILED' && cancelled.evidence.execution.state.values.modelResult === undefined, 'a cancelled result committed');

// --- 7–9. MCP: host-owned retry safety, hostile metadata, unsupported class. ---
const mcpReport = await verifyAdapterConformance({ subject: createMcpConformanceSubject() });
const status = Object.fromEntries(mcpReport.scenarios.map((entry) => [entry.scenarioId, entry.status]));
assert(status['tool.transient-retry'] === 'PASSED', 'host-declared retry-safe MCP Tool was not retried exactly once');
assert(status['tool.unsafe-default-no-retry'] === 'PASSED' && status['tool.discovery-metadata-non-authoritative'] === 'PASSED', 'hostile metadata or the unsafe default enabled a retry');
assert(status['tool.unsupported-permission-blocked'] === 'PASSED' && status['tool.unauthorized-blocked'] === 'PASSED', 'an unsupported or unauthorized MCP call was not blocked');
let sideEffectCalls = 0;
const email = defineTool({ spec: { ...ACCOUNT_SPEC, id: 'mail.send', permissionClasses: ['external_side_effect'] }, handler: { execute: async () => { sideEffectCalls += 1; return { ok: true, output: { id: 'x', name: 'y' } }; } } });
const blocked = await createAAO({ governance, principalForRun: () => alice, tools: [email], clock: clockAt() })
  .prepareWorkflow({ schemaVersion: 1, id: 'smoke.send', version: '1.0.0', name: 'send', entryNodeId: 'send', nodes: [{ id: 'send', kind: 'tool', config: { toolRef: { id: 'mail.send', version: '1.0.0' }, inputStateKey: 'request', resultStateKey: 'sent' } }, { id: 'final', kind: 'final_output', config: {} }], edges: [{ sourceNodeId: 'send', targetNodeId: 'final' }] })
  .execute({ runId: 'run.send', initialState: { runId: 'run.send', revision: 0, values: { request: { accountId: 'a-1' } } } });
assert(!blocked.ok && blocked.failure.code === 'RUNTIME_PREFLIGHT_FAILED' && sideEffectCalls === 0, 'an external_side_effect Tool was not blocked');

// --- 11. The generated matrix is real conformance and matches the committed artifact. ---
const matrix = await runAdaptersMatrix({ format: 'json' });
assert(matrix.exitCode === 0 && matrix.output === readFileSync(join(repositoryRoot, 'docs', 'generated', 'adapter-compatibility.json'), 'utf8'), 'the generated compatibility matrix drifted from docs/generated/adapter-compatibility.json');
const parsed = JSON.parse(matrix.output);
assert(parsed.authority === 'none' && parsed.deferred.some((entry) => entry.id === 'langgraph' && entry.status === 'DEFERRED'), 'matrix authority or LangGraph deferral is wrong');

// --- 12. Full conformance, not report integrity, is a PASS. ---
const datasetRef = { id: ADAPTER_CONFORMANCE_SUITE.dataset.id, version: ADAPTER_CONFORMANCE_SUITE.dataset.version };
const empty = buildAdapterConformanceReport({ manifest: MCP_CONNECTOR_ADAPTER_MANIFEST, datasetRef, scenarios: [], findings: [] });
assert(validateAdapterConformanceReportIntegrity(empty, MCP_CONNECTOR_ADAPTER_MANIFEST).ok && empty.summary.failed === 0, 'an empty report should be intact');
assert(!validateCompleteAdapterConformanceReport(empty, MCP_CONNECTOR_ADAPTER_MANIFEST).ok && !adapterConformancePassed(empty, MCP_CONNECTOR_ADAPTER_MANIFEST), 'an empty conformance report passed');
const partial = await verifyAdapterConformance({ subject: nativeToolReference(), scenarios: [scenario('tool.success-structured-result')] });
assert(partial.summary.failed === 0 && !adapterConformancePassed(partial, NATIVE_TOOL_REFERENCE_MANIFEST), 'a partial conformance report passed');
assert(validateCompleteAdapterConformanceReport(mcpReport, MCP_CONNECTOR_ADAPTER_MANIFEST).ok && adapterConformancePassed(mcpReport, MCP_CONNECTOR_ADAPTER_MANIFEST), 'the complete official MCP report did not pass');
assert(parsed.adapters.every((adapter) => adapter.conformance === 'PASSED'), 'an official adapter is not PASSED in the matrix');

await Promise.all(sessions.map((session) => session.close()));
process.stdout.write(`${JSON.stringify({ manifests: 4, portable: { planFingerprint: a.planFingerprint.slice(0, 12), trajectory: trajectory(a), evals: verdictsA.length }, cancellationObserved: true, mcp: status, sideEffectBlocked: true, matrixAdapters: parsed.adapters.length, fullConformance: { empty: false, partial: false, mcpComplete: true } })}\n`);
process.stdout.write('SPRINT_20_ADAPTER_PORTABILITY_CONTRACT_SMOKE_OK\n');
