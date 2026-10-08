// Process B: reopen every store; Bob approves at T1; the host resumes at T2; derive Metrics and verify Audit.
import process from 'node:process';
import { aggregateRunMetrics, checkAuditCompleteness, deriveRunMetrics, validateAuditStream } from '../../dist/index.js';
import { SECRET, assert, bob, build, manualClock, runId } from './world.mjs';

const [root, approvalId] = process.argv.slice(2);
const clock = manualClock('2026-10-08T10:00:00.000Z');
const { host, approvals, trace, traceStore, audit, auditStore, toolCalls } = build(root, clock);
const t1 = clock.now();
const record = approvals.approve(approvalId, bob);
assert(record.resolvedAt === t1, 'resolution time is not the authoritative decision time');
clock.advance(15 * 60 * 1000);
const result = await host.resume(runId);
assert(result.ok && result.execution.run.status === 'COMPLETED', 'process B did not complete');
await audit.flush();

const events = await traceStore.getRunTrace(runId);
const projection = deriveRunMetrics({ trace: events, traceHealth: trace.runHealth(runId) });
assert(projection.ok && projection.quality === 'complete', 'metrics projection not complete');
const metrics = projection.metrics;
assert(metrics.runStatus === 'COMPLETED' && metrics.durationMs !== null && metrics.durationMs > 0, 'run status/duration wrong');
assert(metrics.retries.scheduled === 1 && metrics.tools.physicalInvocations === 2 && metrics.tools.logicalExecutions === 1, 'restart double-counted retries/Tool calls');
assert(metrics.approvals.requested === 1 && metrics.approvals.approved === 1, 'approval counts wrong');
assert(metrics.durability.checkpointsCreated > 0 && toolCalls().length === 2, 'durability/tool evidence wrong');
const aggregate = aggregateRunMetrics({ runs: [metrics] });
assert(aggregate.ok && aggregate.metrics.runCount === 1 && aggregate.metrics.latency.eligibleRuns === 1, 'aggregate wrong');

const stream = `run:${runId}`;
const auditEvents = await auditStore.getStream(stream);
const labels = auditEvents.map((event) => `${event.type}:${event.actor.id}`);
assert(JSON.stringify(labels) === JSON.stringify(['approval.requested:user.alice', 'approval.resolved:user.bob', 'tool.access.allowed:user.alice', 'tool.access.allowed:user.alice']), `audit sequence wrong: ${labels}`);
const traceResolved = events.find((event) => event.type === 'approval.resolved');
assert(auditEvents[1].occurredAt === t1 && traceResolved.occurredAt !== t1, 'audit/trace approval timing not distinct');
assert(validateAuditStream(auditEvents, { streamId: stream }).valid && (await auditStore.verifyStream(stream)).valid, 'audit chain invalid');
assert(checkAuditCompleteness({ trace: events, audit: auditEvents }).status === 'complete', 'audit incomplete');
assert(!JSON.stringify(auditEvents).includes(SECRET) && !JSON.stringify(metrics).includes(SECRET), 'secret leaked');
process.stdout.write(JSON.stringify({ auditEvents: auditEvents.length, auditResolvedAt: auditEvents[1].occurredAt, traceResolvedAt: traceResolved.occurredAt, runDurationMs: metrics.durationMs, retries: metrics.retries.scheduled, physicalToolCalls: metrics.tools.physicalInvocations, logicalToolExecutions: metrics.tools.logicalExecutions }) + '\n');
