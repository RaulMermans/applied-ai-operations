// Process C: recover the ambiguous idempotent Tool operation and complete.
import process from 'node:process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assert, buildHost, runId } from './world.mjs';

const [root, approvalId] = process.argv.slice(2);
const { host, world } = buildHost(root);
const before = await host.getRun(runId);
assert(before.status === 'RUNNING' && before.operations.at(-1).nodeId === 'draft' && before.operations.at(-1).status === 'STARTED', 'phase 3 did not find the ambiguous Tool operation');
const result = await host.resume(runId);
assert(result.ok && result.execution.run.status === 'COMPLETED' && result.execution.run.runId === runId, 'phase 3 did not complete');
const effects = world.read();
assert(effects.prepare === 1, 'prepare was re-executed');
assert(effects.toolCalls === 2 && Object.keys(effects.drafts).length === 1 && new Set(effects.toolExecutionIds).size === 1, 'idempotent replay produced more than one logical draft');
assert(readdirSync(join(root, 'approvals')).length === 1 && host.getApproval(approvalId).status === 'approved', 'approval was duplicated or lost');
const again = await host.resume(runId);
assert(again.ok && again.execution.run.status === 'COMPLETED' && world.read().toolCalls === 2, 'terminal Run executed again');
process.stdout.write(JSON.stringify({ physicalToolCalls: effects.toolCalls, logicalDrafts: Object.keys(effects.drafts).length, uniqueToolExecutionIds: new Set(effects.toolExecutionIds).size, prepareExecutions: effects.prepare }) + '\n');
