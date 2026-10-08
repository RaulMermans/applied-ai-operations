// Process A: execute to the durable approval wait (Audit: approval.requested), then exit.
import process from 'node:process';
import { assert, build, manualClock, runId } from './world.mjs';

const { host, audit, auditStore } = build(process.argv[2], manualClock('2026-10-08T09:00:00.000Z'));
const result = await host.execute({ runId, initialState: { runId, revision: 0, values: {} } });
assert(result.ok && result.execution.run.status === 'WAITING_FOR_APPROVAL', 'process A did not reach the durable wait');
await audit.flush();
const events = await auditStore.getStream(`run:${runId}`);
assert(events.length === 1 && events[0].type === 'approval.requested', 'process A audit stream wrong');
assert(audit.health().status === 'healthy', 'process A audit degraded');
process.stdout.write(JSON.stringify({ approvalId: result.execution.wait.referenceId, auditEvents: events.length }) + '\n');
