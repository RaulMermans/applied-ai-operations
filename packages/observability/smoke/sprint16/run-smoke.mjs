// Sprint 16 compiled Metrics + Audit smoke. Run after `pnpm build`; uses only dist/.
//  1. One process: compiled YAML → Runtime → approval wait → Bob approves at T1
//     → continuation at T2 → Tool transient failure → retry → success →
//     Trace → RunMetrics → AggregateMetrics; Audit chain verified; then a
//     real Model Runtime Run for token usage and explicit-pricing cost coverage.
//  2. Two separate Node processes over one temporary root: Process A reaches
//     the durable wait; Process B approves, resumes, and verifies continued
//     Trace-derived Metrics and the continued, valid Audit hash chain.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { continueApprovedWorkflow } from '@aao/approval';
import { createModelNodeExecutor, createModelPolicyRegistry, createModelRegistry } from '@aao/model-runtime';
import { createNodeRegistry, executeWorkflow, finalOutputExecutor } from '@aao/runtime';
import { compileWorkflowSource } from '@aao/workflow-dsl';
import { aggregateRunMetrics, createAuditRecorder, createInMemoryAuditStore, createInMemoryTraceStore, createTraceRecorder, deriveRunMetrics, summarizeObservabilityHealth, validateAuditStream } from '../../dist/index.js';
import { SECRET, assert, bob, components, manualClock, memoryCalls, reliability } from './world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'aao-s16-smoke-'));
try {
  // --- 1a. Single process: flagship workflow with Metrics and Audit (in-memory stores). ---
  const clock = manualClock('2026-10-08T09:00:00.000Z');
  const traceStore = createInMemoryTraceStore();
  const trace = createTraceRecorder({ store: traceStore, clock });
  const auditStore = createInMemoryAuditStore();
  const audit = createAuditRecorder({ store: auditStore, clock });
  const log = memoryCalls();
  const { approvals: engine, registry: single, plan } = components({ clock, audit, log });
  const options = { clock, sleeper: { sleep: async () => undefined }, reliability, trace };
  const runId = 'run.smoke.s16.single';

  const waiting = await executeWorkflow({ runId, plan, registry: single, initialState: { runId, revision: 0, values: {} }, options });
  assert(waiting.ok && waiting.execution.run.status === 'WAITING_FOR_APPROVAL', 'did not reach the approval wait');
  clock.advance(60 * 60 * 1000);
  const t1 = clock.now();
  engine.approve(waiting.execution.wait.referenceId, bob);
  clock.advance(30 * 60 * 1000);
  const t2 = clock.now();
  const done = await continueApprovedWorkflow(engine, { plan, registry: single, execution: waiting.execution, options });
  assert(done.ok && done.execution.run.status === 'COMPLETED', 'did not complete');
  await audit.flush();

  const events = await traceStore.getRunTrace(runId);
  const projection = deriveRunMetrics({ trace: events, traceHealth: trace.runHealth(runId) });
  assert(projection.ok && projection.quality === 'complete', 'metrics not complete');
  const m = projection.metrics;
  assert(m.runStatus === 'COMPLETED', 'run status wrong');
  assert(m.durationMs === Date.parse(events.at(-1).occurredAt) - Date.parse(events[0].occurredAt), 'duration not lifecycle-derived');
  assert(m.approvalWaitDurationMs === 90 * 60 * 1000, `approval wait wrong: ${m.approvalWaitDurationMs}`);
  assert(log.read().length === 2 && m.retries.scheduled === 1 && m.tools.physicalInvocations === 2 && m.tools.logicalExecutions === 1 && m.tools.failed === 1 && m.tools.completed === 1, 'retry/Tool metrics wrong');
  assert(m.approvals.requested === 1 && m.approvals.approved === 1, 'approval count wrong');
  assert(m.tokenUsage.status === 'complete' && m.tokenUsage.totalTokens === 0 && m.cost.status === 'complete', 'model-free token/cost accounting wrong');

  const auditEvents = await auditStore.getStream(`run:${runId}`);
  const auditTypes = auditEvents.map((event) => event.type);
  assert(JSON.stringify(auditTypes) === JSON.stringify(['approval.requested', 'approval.resolved', 'tool.access.allowed', 'tool.access.allowed']), `audit types wrong: ${auditTypes}`);
  const traceResolved = events.find((event) => event.type === 'approval.resolved');
  assert(auditEvents[1].occurredAt === t1 && traceResolved.occurredAt === t2, 'source-time vs consumption-time approval semantics broken');
  assert(validateAuditStream(auditEvents).valid, 'audit chain invalid');
  assert(!JSON.stringify(auditEvents).includes(SECRET) && !JSON.stringify(m).includes(SECRET), 'secret leaked');
  const health = summarizeObservabilityHealth({ trace: trace.health(), audit: audit.health() });
  assert(health.trace === 'healthy' && health.audit === 'healthy', 'observability degraded');

  // --- 1b. Real Model Runtime: token usage and explicit-pricing cost coverage. ---
  const modelYaml = `
schemaVersion: 1
id: smoke.s16.model
version: "1.0.0"
name: Smoke model
entryNodeId: summarize
nodes:
  - id: summarize
    kind: model
    config: { modelPolicyRef: policy.default, requestStateKey: request, resultStateKey: summary }
  - id: final
    kind: final_output
    config: {}
edges:
  - { sourceNodeId: summarize, targetNodeId: final }
`;
  const models = createModelRegistry();
  models.register({ id: 'local.fast', priority: 1, capabilities: ['model.text_generation'], adapter: { invoke: async () => ({ status: 'succeeded', output: 'summary', finishReason: 'stop', usage: { inputTokens: 1200, outputTokens: 350, totalTokens: 1550 } }) }, identity: { provider: 'example', model: 'example-model' } });
  const policies = createModelPolicyRegistry();
  policies.register({ schemaVersion: 1, id: 'policy.default', version: '1.0.0', name: 'Default' });
  const modelRegistry = createNodeRegistry();
  modelRegistry.register(createModelNodeExecutor({ models, policies }));
  modelRegistry.register(finalOutputExecutor);
  const modelStore = createInMemoryTraceStore();
  const modelRunId = 'run.smoke.s16.model';
  const compiledModel = compileWorkflowSource(modelYaml, 'yaml');
  assert(compiledModel.ok, 'model workflow did not compile');
  const modelResult = await executeWorkflow({ runId: modelRunId, plan: compiledModel.plan, registry: modelRegistry, initialState: { runId: modelRunId, revision: 0, values: { request: { schemaVersion: 1, invocationId: 'inv.1', messages: [{ role: 'user', content: SECRET }], output: { kind: 'text' } } } }, options: { clock, trace: createTraceRecorder({ store: modelStore, clock }) } });
  assert(modelResult.ok, 'model run failed');
  const pricing = [{ schemaVersion: 1, profileId: 'pricing.example', profileVersion: '2026-01', provider: 'example', model: 'example-model', currency: 'USD', inputNanosPerMillionTokens: 3000000000, outputNanosPerMillionTokens: 15000000000 }];
  const modelTrace = await modelStore.getRunTrace(modelRunId);
  const priced = deriveRunMetrics({ trace: modelTrace, pricing });
  const unpriced = deriveRunMetrics({ trace: modelTrace });
  assert(priced.ok && priced.metrics.tokenUsage.totalTokens === 1550 && priced.metrics.cost.estimatedCostNanos === 8850000 && priced.metrics.cost.status === 'complete', 'priced cost wrong');
  assert(unpriced.ok && unpriced.metrics.tokenUsage.totalTokens === 1550 && unpriced.metrics.cost.status === 'unavailable' && unpriced.metrics.cost.estimatedCostNanos === null, 'missing pricing became a number');
  const aggregate = aggregateRunMetrics({ runs: [m, priced.metrics] });
  assert(aggregate.ok && aggregate.metrics.runCount === 2 && aggregate.metrics.successRate.value === 1 && aggregate.metrics.retries.retryingRunRate.numerator === 1 && aggregate.metrics.approvals.approvalRequiredRunRate.denominator === 2 && aggregate.metrics.cost.costCoverage.value === 1, 'aggregate wrong');
  process.stdout.write(`${JSON.stringify({ run: { status: m.runStatus, durationMs: m.durationMs, approvalWaitDurationMs: m.approvalWaitDurationMs, retries: m.retries.scheduled, physicalToolCalls: m.tools.physicalInvocations, logicalToolExecutions: m.tools.logicalExecutions, approvals: m.approvals.requested }, audit: auditTypes, auditResolvedAt: t1, traceResolvedAt: t2, model: { totalTokens: priced.metrics.tokenUsage.totalTokens, estimatedCostNanos: priced.metrics.cost.estimatedCostNanos, unpricedCost: unpriced.metrics.cost.status }, aggregate: { runCount: aggregate.metrics.runCount, p50RunDurationMs: aggregate.metrics.latency.p50RunDurationMs, costCoverage: aggregate.metrics.cost.costCoverage } })}\n`);

  // --- 2. Durable restart across two Node processes. ---
  const durableRoot = join(root, 'durable');
  const phase = (name, ...args) => spawnSync(process.execPath, [join(here, name), durableRoot, ...args], { encoding: 'utf8' });
  const a = phase('phase-a.mjs');
  if (a.status !== 0) throw new Error(`process A failed: ${a.stderr}`);
  const fromA = JSON.parse(a.stdout.trim());
  const b = phase('phase-b.mjs', fromA.approvalId);
  if (b.status !== 0) throw new Error(`process B failed: ${b.stderr}`);
  process.stdout.write(b.stdout);
  process.stdout.write('SPRINT_16_METRICS_AUDIT_SMOKE_OK\n');
} finally {
  rmSync(root, { recursive: true, force: true });
}
