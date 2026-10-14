// Sprint 17 compiled Evaluation Runtime smoke. Run after `pnpm build`; uses only dist/.
//  1. OFFLINE: load the versioned Eval Definitions and the runtime-foundation
//     dataset (YAML), resolve canonical fixture evidence through an explicit
//     host mapping, run every deterministic grader, and check every case's
//     stated expectation.
//  2. Model judge: a bounded fake judge through the provider-independent
//     port — one call, structured score, nothing persisted; a throwing judge
//     is `error`, never `failed`.
//  3. RUNTIME: a real compiled AAO Run (prepare → approval → retry-safe Tool →
//     final) with Trace and Audit, evaluated after the Runtime returned; the
//     Run's state is unchanged by evaluation.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { continueApprovedWorkflow, createApprovalEngine, createApprovalNodeExecutor } from '@aao/approval';
import { createGovernanceRegistry } from '@aao/governance';
import { createAuditRecorder, createInMemoryAuditStore, createInMemoryTraceStore, createTraceRecorder, deriveRunMetrics } from '@aao/observability';
import { createNodeRegistry, executeWorkflow, finalOutputExecutor } from '@aao/runtime';
import { createToolNodeExecutor, createToolRegistry } from '@aao/tool-runtime';
import { compileWorkflowSource } from '@aao/workflow-dsl';
import { createEvaluatorRegistry, createModelJudgeGrader, createStaticEvidenceResolver, deterministicGraders, evaluate, parseEvalDataset, parseEvalDefinitions, runEvalDataset } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const evals = join(here, '..', '..', '..', 'evals');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const SECRET = 'SECRET_DO_NOT_PERSIST';

// --- 1. OFFLINE dataset over committed fixture evidence. ---
const definitions = parseEvalDefinitions(readFileSync(join(evals, 'definitions', 'runtime-foundation.v1.yaml'), 'utf8'), 'yaml');
assert(definitions.ok, 'definitions invalid');
const dataset = parseEvalDataset(readFileSync(join(evals, 'datasets', 'runtime-foundation.v2.yaml'), 'utf8'), 'yaml');
assert(dataset.ok, 'dataset invalid');
const fixtureNames = readdirSync(join(evals, 'fixtures')).filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -5));
const resolver = createStaticEvidenceResolver(fixtureNames.map((name) => [`fixture://${name}`, JSON.parse(readFileSync(join(evals, 'fixtures', `${name}.json`), 'utf8'))]));
const registry = createEvaluatorRegistry(deterministicGraders());
const offline = await runEvalDataset({ dataset: dataset.value, definitions: definitions.value, registry, evidenceResolver: resolver });
assert(offline.ok, 'dataset run refused');
const cases = offline.run.cases;
assert(cases.length === dataset.value.cases.length, 'not one result per case');
const mismatched = cases.filter((entry) => entry.matchesExpectation !== true).map((entry) => entry.caseId);
assert(mismatched.length === 0, `cases not matching expectation: ${mismatched}`);
const byStatus = (status) => cases.filter((entry) => entry.result.status === status).length;
const repeat = await runEvalDataset({ dataset: dataset.value, definitions: definitions.value, registry, evidenceResolver: resolver });
assert(JSON.stringify(repeat) === JSON.stringify(offline), 'dataset run not deterministic');

// --- 2. Bounded fake model judge through the injected port. ---
let judgeCalls = 0;
const judgeRegistry = createEvaluatorRegistry([...deterministicGraders(), createModelJudgeGrader({ judge: { judge: async (request) => { judgeCalls += 1; assert(Object.keys(request).sort().join() === 'rubric,subject', 'judge saw more than rubric + subject'); return { passed: true, score: 0.86, dimensionScores: [{ id: 'faithfulness', score: 0.9 }] }; } } })]);
const judgeDefinition = { schemaVersion: 2, id: 'smoke.summary-quality', version: '1.0.0', name: 'Summary quality', categories: ['output_quality'], supportedModes: ['OFFLINE'], targetType: 'artifact', graderRef: { id: 'aao.model-judge', version: '1.0.0' }, config: { rubric: { criteria: 'Faithful summary', dimensions: [{ id: 'faithfulness', description: 'No unsupported claims', minScore: 0.7 }] }, passThreshold: 0.8 } };
const subjectEvidence = { origin: 'recorded', runId: 'run.smoke.judge', subject: { id: 'summary.smoke', content: `A summary containing ${SECRET}` } };
const judged = await evaluate({ definition: judgeDefinition, mode: 'OFFLINE', evidence: subjectEvidence, registry: judgeRegistry });
assert(judged.status === 'passed' && judged.score === 0.86 && judgeCalls === 1, 'judge result wrong');
assert(!JSON.stringify(judged).includes(SECRET), 'judge subject persisted');
const brokenRegistry = createEvaluatorRegistry([createModelJudgeGrader({ judge: { judge: async () => { throw new Error('provider down'); } } })]);
const broken = await evaluate({ definition: judgeDefinition, mode: 'OFFLINE', evidence: subjectEvidence, registry: brokenRegistry });
assert(broken.status === 'error' && broken.errorCode === 'EVAL_MODEL_JUDGE_ERROR', 'judge failure was not an error');

// --- 3. RUNTIME evaluation of a real compiled Run. ---
// One ticking clock per component (as in the test worlds), so traced durations reflect only the Run's own events.
const clockFrom = (offset) => { let tick = offset; return { now: () => new Date(Date.UTC(2026, 9, 13, 9, 0, 0) + 1000 * tick++).toISOString() }; };
const clock = clockFrom(0);
const alice = { id: 'user.alice', type: 'user' };
const bob = { id: 'user.bob', type: 'user' };
const yaml = readFileSync(join(here, 'flagship.yaml'), 'utf8');
const compiled = compileWorkflowSource(yaml, 'yaml');
assert(compiled.ok, 'workflow did not compile');
const governance = createGovernanceRegistry({ actors: [alice, bob], roles: [{ id: 'operator', version: '1.0.0', permissionClasses: ['read_only'] }, { id: 'manager', version: '1.0.0', permissionClasses: ['read_only'] }], bindings: [{ id: 'alice.operator', actorId: alice.id, roleId: 'operator', status: 'active' }, { id: 'bob.manager', actorId: bob.id, roleId: 'manager', status: 'active' }], policies: [] });
const traceStore = createInMemoryTraceStore();
const trace = createTraceRecorder({ store: traceStore, clock: clockFrom(0) });
const auditStore = createInMemoryAuditStore();
const audit = createAuditRecorder({ store: auditStore, clock: clockFrom(500) });
const approvals = createApprovalEngine({ governance, clock: clockFrom(100), audit });
const tools = createToolRegistry();
let toolCalls = 0;
tools.register({ spec: { schemaVersion: 1, id: 'local.lookup', version: '1.0.0', name: 'Lookup', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, permissionClasses: ['read_only'] }, retrySafety: 'safe', handler: { execute: async () => { toolCalls += 1; return toolCalls === 1 ? { ok: false, code: 'UPSTREAM_UNAVAILABLE', retryable: true } : { ok: true, output: { account: 'account-a', token: SECRET } }; } } });
const nodes = createNodeRegistry();
nodes.register({ kind: 'deterministic', recoverySafety: () => 'safe', execute: async () => ({ ok: true, statePatch: { proposal: { action: 'lookup', target: 'account-a' } } }) });
nodes.register(createApprovalNodeExecutor(approvals, () => alice));
nodes.register(createToolNodeExecutor({ tools, resolveAuthorizationContext: () => ({ schemaVersion: 1, principal: alice, grantedPermissionClasses: ['read_only'] }), audit }));
nodes.register(finalOutputExecutor);
const options = { clock, sleeper: { sleep: async () => undefined }, trace, reliability: { policiesByNodeId: { lookup: { maxAttempts: 3 } } } };
const runId = 'run.smoke.s17';
const waiting = await executeWorkflow({ runId, plan: compiled.plan, registry: nodes, initialState: { runId, revision: 0, values: {} }, options });
assert(waiting.ok && waiting.execution.run.status === 'WAITING_FOR_APPROVAL', 'did not reach the approval wait');
approvals.approve(waiting.execution.wait.referenceId, bob);
const done = await continueApprovedWorkflow(approvals, { plan: compiled.plan, registry: nodes, execution: waiting.execution, options });
assert(done.ok && done.execution.run.status === 'COMPLETED', 'run did not complete');
await audit.flush();
const events = await traceStore.getRunTrace(runId);
const metrics = deriveRunMetrics({ trace: events, traceHealth: trace.runHealth(runId) });
assert(metrics.ok, 'metrics projection failed');
const evidence = { origin: 'live_run', runId, trace: events, execution: done.execution, metrics: metrics.metrics, audit: await auditStore.getStream(`run:${runId}`) };
const before = JSON.stringify({ execution: done.execution, toolCalls, trace: events.length });
const byId = new Map(definitions.value.map((definition) => [definition.id, definition]));
const runtimeIds = ['trace.contract-valid', 'run.completed', 'trajectory.flagship-exact', 'tool.lookup-required', 'tool.no-external-send', 'approval.required-and-approved', 'retry.within-budget', 'metrics.operational-budget'];
const runtimeResults = [];
for (const id of runtimeIds) runtimeResults.push(await evaluate({ definition: byId.get(id), mode: 'RUNTIME', evidence, registry }));
const notPassed = runtimeResults.filter((result) => result.status !== 'passed').map((result) => `${result.evalRef.id}:${result.status}:${result.errorCode ?? ''}`);
assert(notPassed.length === 0, `runtime evals not passed: ${notPassed}`);
assert(JSON.stringify({ execution: done.execution, toolCalls, trace: (await traceStore.getRunTrace(runId)).length }) === before, 'evaluation changed execution evidence');
assert(!JSON.stringify(runtimeResults).includes(SECRET), 'secret leaked into an EvalResult');

process.stdout.write(`${JSON.stringify({
  offline: { dataset: `${offline.run.datasetRef.id}@${offline.run.datasetRef.version}`, cases: cases.length, passed: byStatus('passed'), failed: byStatus('failed'), error: byStatus('error'), matchingExpectation: cases.length - mismatched.length },
  judge: { status: judged.status, score: judged.score, calls: judgeCalls, failingAdapter: broken.errorCode },
  runtime: { runId, traceEvents: events.length, evaluated: runtimeResults.map((result) => `${result.evalRef.id}:${result.status}`) },
})}\n`);
process.stdout.write('SPRINT_17_EVALUATION_RUNTIME_SMOKE_OK\n');
