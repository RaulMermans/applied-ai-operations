// Process B: load the same Run and Approval, approve, resume. The Tool creates
// its draft and the process dies before the accepted outcome is durable.
import process from 'node:process';
import { assert, bob, buildHost, runId } from './world.mjs';

const [root, approvalId] = process.argv.slice(2);
const { host, approvals } = buildHost(root, { crashInsideTool: true });
const view = await host.getRun(runId);
assert(view && view.status === 'WAITING_FOR_APPROVAL' && view.execution.nodeStatusesById.prepare === 'SUCCEEDED', 'phase 2 did not load the waiting Run');
assert(view.execution.wait.referenceId === approvalId && approvals.getApproval(approvalId)?.status === 'pending', 'phase 2 did not load the same pending Approval');
approvals.approve(approvalId, bob);
await host.resume(runId);
throw new Error('phase 2 should have crashed inside the Tool');
