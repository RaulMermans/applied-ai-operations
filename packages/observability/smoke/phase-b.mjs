// Process B: reopen the same durability and Trace stores, approve, resume, complete.
import process from 'node:process';
import { validateTrace, compareTraceWithExecution } from '../dist/index.js';
import { SECRET, assert, bob, build, labels, runId } from './world.mjs';

const [root, approvalId, traceIdA, eventsA] = process.argv.slice(2);
const { host, approvals, recorder, traceStore, toolCalls } = build(root, 1000);
approvals.approve(approvalId, bob);
const result = await host.resume(runId);
assert(result.ok && result.execution.run.status === 'COMPLETED', 'process B did not complete');
const events = await traceStore.getRunTrace(runId);
const traj = labels(events);
assert(new Set(events.map((event) => event.traceId)).size === 1 && events[0].traceId === traceIdA, 'traceId changed across restart');
assert(events.every((event, index) => event.sequence === index) && events.length > Number(eventsA), 'sequence did not continue contiguously');
assert(new Set(events.map((event) => event.eventId)).size === events.length, 'duplicate events after restart');
assert(traj.filter((label) => label === 'run.started').length === 1, 'run.started duplicated');
assert(traj.filter((label) => /^run\.(completed|failed|cancelled)$/.test(label)).length === 1 && traj.at(-1) === 'run.completed', 'not exactly one terminal event');
assert(toolCalls().length === 2, 'unexpected physical Tool calls');
const lookup = traj.filter((label) => label.endsWith('@lookup') && /tool|retry/.test(label));
assert(JSON.stringify(lookup) === JSON.stringify(['tool.call.started@lookup', 'tool.call.failed@lookup', 'retry.scheduled@lookup', 'tool.call.started@lookup', 'tool.call.completed@lookup']), `retry trail wrong: ${lookup}`);
assert(traj.includes('approval.requested@approval') && traj.includes('approval.resolved@approval'), 'approval trail missing');
assert(validateTrace(events, { runStatus: 'COMPLETED' }).valid, 'trace invalid');
assert(compareTraceWithExecution(events, result.execution).valid, 'trace disagrees with Runtime state');
assert(!JSON.stringify(events).includes(SECRET), 'secret reached the trace');
assert(recorder.health().status === 'healthy', 'process B trace degraded');
process.stdout.write(JSON.stringify({ traceId: events[0].traceId, eventsAfterA: Number(eventsA), eventsTotal: events.length, runStarted: 1, terminal: traj.at(-1), physicalToolCalls: toolCalls().length }) + '\n');
