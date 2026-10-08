// Sprint 15 compiled Trace Runtime smoke. Run after `pnpm build`; uses only dist/.
//  1. One process: compiled YAML → Runtime → approval wait → approve → Tool
//     transient failure → retry → success → complete → TraceStore → validateTrace.
//  2. Two genuinely separate Node processes over one temporary root:
//     Process A runs to the durable wait; Process B reopens the durability and
//     Trace stores, approves, resumes, and completes the same trace.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { continueApprovedWorkflow } from '@aao/approval';
import { executeWorkflow } from '@aao/runtime';
import { createInMemoryTraceStore, createTraceRecorder, validateTrace } from '../dist/index.js';
import { SECRET, assert, bob, build, clockAt, labels } from './world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'aao-trace-smoke-'));
try {
  // --- 1. Single process, nondurable Runtime, in-memory Trace Store. ---
  const { registry, plan, approvals, toolCalls } = build(join(root, 'single'), 0);
  const store = createInMemoryTraceStore();
  const recorder = createTraceRecorder({ store, clock: clockAt(0) });
  const options = { clock: clockAt(0), sleeper: { sleep: async () => undefined }, reliability: { policiesByNodeId: { lookup: { maxAttempts: 3 } } }, trace: recorder };
  const runId = 'run.smoke.trace.single';
  const waiting = await executeWorkflow({ runId, plan, registry, initialState: { runId, revision: 0, values: {} }, options });
  assert(waiting.ok && waiting.execution.run.status === 'WAITING_FOR_APPROVAL', 'did not reach the approval wait');
  approvals.approve(waiting.execution.wait.referenceId, bob);
  const done = await continueApprovedWorkflow(approvals, { plan, registry, execution: waiting.execution, options });
  assert(done.ok && done.execution.run.status === 'COMPLETED', 'did not complete');
  const events = await store.getRunTrace(runId);
  const traj = labels(events);
  assert(validateTrace(events, { runStatus: 'COMPLETED' }).valid, 'trace invalid');
  assert(new Set(events.map((event) => event.traceId)).size === 1, 'more than one trace id');
  assert(events.every((event, index) => event.sequence === index), 'sequence not strict');
  const approvalTrail = traj.filter((label) => label.startsWith('approval.') || label === 'node.waiting@approval');
  assert(JSON.stringify(approvalTrail) === JSON.stringify(['approval.requested@approval', 'node.waiting@approval', 'approval.resolved@approval']), 'approval trail invalid');
  assert(traj.includes('retry.scheduled@lookup'), 'retry not visible');
  assert(toolCalls().length === 2 && traj.filter((label) => label === 'tool.call.started@lookup').length === 2, 'Tool physical calls do not match the trace');
  assert(traj.at(-1) === 'run.completed', 'terminal run.completed missing');
  assert(!JSON.stringify(events).includes(SECRET), 'secret reached the trace');
  assert(recorder.health().status === 'healthy', 'recorder degraded');
  process.stdout.write(`${traj.map((label, index) => `${String(index).padStart(2, '0')} ${label}`).join('\n')}\n`);

  // --- 2. Durable restart across two Node processes. ---
  const durableRoot = join(root, 'durable');
  const phase = (name, ...args) => spawnSync(process.execPath, [join(here, name), durableRoot, ...args], { encoding: 'utf8' });
  const a = phase('phase-a.mjs');
  if (a.status !== 0) throw new Error(`process A failed: ${a.stderr}`);
  const fromA = JSON.parse(a.stdout.trim());
  const b = phase('phase-b.mjs', fromA.approvalId, fromA.traceId, String(fromA.events));
  if (b.status !== 0) throw new Error(`process B failed: ${b.stderr}`);
  process.stdout.write(b.stdout);
  process.stdout.write('SPRINT_15_TRACE_RUNTIME_SMOKE_OK\n');
} finally {
  rmSync(root, { recursive: true, force: true });
}
