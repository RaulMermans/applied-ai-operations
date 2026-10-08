// Process A: execute to the durable approval wait with tracing, then exit.
import process from 'node:process';
import { assert, build, runId } from './world.mjs';

const { host, recorder, traceStore } = build(process.argv[2], 0);
const result = await host.execute({ runId, initialState: { runId, revision: 0, values: {} } });
assert(result.ok && result.execution.run.status === 'WAITING_FOR_APPROVAL', 'process A did not reach the durable wait');
const events = await traceStore.getRunTrace(runId);
assert(events.at(-1).type === 'node.waiting', 'process A trace does not end at the wait');
assert(recorder.health().status === 'healthy', 'process A trace degraded');
process.stdout.write(JSON.stringify({ approvalId: result.execution.wait.referenceId, traceId: events[0].traceId, events: events.length }) + '\n');
