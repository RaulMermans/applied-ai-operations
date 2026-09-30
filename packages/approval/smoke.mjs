// Real compiled-package acceptance path. Run after pnpm build.
import process from 'node:process';
import { createGovernanceRegistry } from '@aao/governance';
import { compileWorkflowSource } from '@aao/workflow-dsl';
import { createNodeRegistry, executeWorkflow, finalOutputExecutor } from '@aao/runtime';
import { createToolRegistry, createToolNodeExecutor } from '@aao/tool-runtime';
import { createApprovalEngine, createApprovalNodeExecutor, continueApprovedWorkflow } from './dist/index.js';

const alice = { id: 'user.alice', type: 'user' };
const bob = { id: 'user.bob', type: 'user' };
const governance = createGovernanceRegistry({
  actors: [alice, bob],
  roles: [
    { id: 'operator', version: '1.0.0', permissionClasses: ['write_draft'] },
    { id: 'manager', version: '1.0.0', permissionClasses: ['write_draft'] },
  ],
  bindings: [
    { id: 'alice.operator', actorId: alice.id, roleId: 'operator', status: 'active' },
    { id: 'bob.manager', actorId: bob.id, roleId: 'manager', status: 'active' },
  ],
  policies: [],
});
const yaml = `
schemaVersion: 1
id: smoke.approval
version: "1.0.0"
name: Smoke approval
entryNodeId: proposal
nodes:
  - id: proposal
    kind: deterministic
    config: {}
  - id: approval
    kind: approval
    config:
      subjectStateKey: proposal
      permissionClasses: [write_draft]
      requiredApproverRoleIds: [manager]
  - id: draft
    kind: tool
    config:
      toolRef: { id: local.draft, version: "1.0.0" }
      inputStateKey: proposal
      resultStateKey: draftResult
  - id: final
    kind: final_output
    config: {}
edges:
  - { sourceNodeId: proposal, targetNodeId: approval }
  - { sourceNodeId: approval, targetNodeId: draft }
  - { sourceNodeId: draft, targetNodeId: final }
`;
const compiled = compileWorkflowSource(yaml, 'yaml');
if (!compiled.ok) throw new Error('Compilation failed');
let tick = 0;
const clock = { now: () => new Date(Date.UTC(2026, 8, 30, 12, 0, tick++)).toISOString() };
const approvals = createApprovalEngine({ governance, clock });
const tools = createToolRegistry();
let calls = 0;
tools.register({
  spec: { schemaVersion: 1, id: 'local.draft', version: '1.0.0', name: 'Draft', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, permissionClasses: ['write_draft'] },
  handler: { async execute() { calls++; return { ok: true, output: { saved: true } }; } },
});
const registry = createNodeRegistry();
registry.register({ kind: 'deterministic', async execute() { return { ok: true, statePatch: { proposal: { action: 'prepare-draft', target: 'account-a' } } }; } });
registry.register(createApprovalNodeExecutor(approvals, () => alice));
registry.register(createToolNodeExecutor({ tools, resolveAuthorizationContext: () => ({ schemaVersion: 1, principal: alice, grantedPermissionClasses: ['write_draft'] }) }));
registry.register(finalOutputExecutor);
for (const [runId, decision] of [['run.smoke.approved', 'approve'], ['run.smoke.rejected', 'reject']]) {
  const waiting = await executeWorkflow({ runId, plan: compiled.plan, registry, initialState: { runId, revision: 0, values: {} }, options: { clock } });
  if (!waiting.ok || waiting.execution.run.status !== 'WAITING_FOR_APPROVAL' || waiting.execution.nodeStatusesById.approval !== 'WAITING' || waiting.execution.nodeStatusesById.draft !== 'PENDING' || calls !== (decision === 'approve' ? 0 : 1)) throw new Error('Wait invariant failed');
  approvals[decision](waiting.execution.wait.referenceId, bob);
  const result = await continueApprovedWorkflow(approvals, { plan: compiled.plan, registry, execution: waiting.execution, options: { clock } });
  if (decision === 'approve' && (!result.ok || result.execution.run.status !== 'COMPLETED' || calls !== 1)) throw new Error('Approval continuation failed');
  if (decision === 'reject' && (result.ok || result.execution.run.status !== 'FAILED' || result.execution.nodeStatusesById.draft !== 'PENDING' || calls !== 1)) throw new Error('Rejection boundary failed');
}
process.stdout.write('SPRINT_12_APPROVAL_ENGINE_SMOKE_OK\n');
