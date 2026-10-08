// Process A: execute to the durable approval wait, then exit.
import process from 'node:process';
import { assert, buildHost, runId } from './world.mjs';

const { host, world } = buildHost(process.argv[2]);
const result = await host.execute({ runId, initialState: { runId, revision: 0, values: {} } });
assert(result.ok && result.execution.run.status === 'WAITING_FOR_APPROVAL', 'phase 1 did not reach a durable wait');
assert(world.read().prepare === 1 && world.read().toolCalls === 0, 'phase 1 executed unexpected work');
process.stdout.write(`${result.execution.wait.referenceId}\n`);
