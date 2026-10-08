// Shared construction for the Sprint 14 compiled smoke. Every phase is a fresh
// Node process that builds its store, approval engine, registries, and durable
// host from scratch over the same temporary root. Run after `pnpm build`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { join } from 'node:path';
import { createApprovalEngine, createApprovalNodeExecutor } from '@aao/approval';
import { createGovernanceRegistry } from '@aao/governance';
import { createNodeRegistry, finalOutputExecutor } from '@aao/runtime';
import { createToolNodeExecutor, createToolRegistry } from '@aao/tool-runtime';
import { compileWorkflowSource } from '@aao/workflow-dsl';
import { createDurableRuntimeHost, createFileDurabilityStore } from '../dist/index.js';

export const runId = 'run.smoke.durable';
export const alice = { id: 'user.alice', type: 'user' };
export const bob = { id: 'user.bob', type: 'user' };

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** File-backed "external world": counts and drafts survive process death, like a real downstream system. */
export function effects(root) {
  const path = join(root, 'effects.json');
  const read = () => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { prepare: 0, toolCalls: 0, toolExecutionIds: [], drafts: {} });
  const write = (value) => writeFileSync(path, JSON.stringify(value));
  return { read, update: (change) => { const value = read(); change(value); write(value); return value; } };
}

const yaml = `
schemaVersion: 1
id: smoke.durable
version: "1.0.0"
name: Smoke durable execution
entryNodeId: prepare
nodes:
  - id: prepare
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
  - { sourceNodeId: prepare, targetNodeId: approval }
  - { sourceNodeId: approval, targetNodeId: draft }
  - { sourceNodeId: draft, targetNodeId: final }
`;

/** `crashInsideTool`: the Tool creates its draft, then the process dies before its outcome is durable. */
export function buildHost(root, { crashInsideTool = false } = {}) {
  const compiled = compileWorkflowSource(yaml, 'yaml');
  if (!compiled.ok) throw new Error('Compilation failed');
  const governance = createGovernanceRegistry({
    actors: [alice, bob],
    roles: [{ id: 'operator', version: '1.0.0', permissionClasses: ['write_draft'] }, { id: 'manager', version: '1.0.0', permissionClasses: ['read_only'] }],
    bindings: [{ id: 'alice.operator', actorId: alice.id, roleId: 'operator', status: 'active' }, { id: 'bob.manager', actorId: bob.id, roleId: 'manager', status: 'active' }],
    policies: [],
  });
  const store = createFileDurabilityStore({ root });
  const approvals = createApprovalEngine({ governance, clock: { now: () => new Date().toISOString() }, repository: store.approvals });
  const world = effects(root);
  const tools = createToolRegistry();
  tools.register({
    spec: { schemaVersion: 1, id: 'local.draft', version: '1.0.0', name: 'Draft', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, permissionClasses: ['write_draft'] },
    idempotency: 'execution_id',
    handler: {
      async execute({ toolExecutionId }) {
        const value = world.update((state) => {
          state.toolCalls += 1;
          state.toolExecutionIds.push(toolExecutionId);
          // Honors the execution-id contract: one logical draft per toolExecutionId.
          state.drafts[toolExecutionId] ??= Object.keys(state.drafts).length + 1;
        });
        if (crashInsideTool) process.exit(70);
        return { ok: true, output: { draftNumber: value.drafts[toolExecutionId] } };
      },
    },
  });
  const registry = createNodeRegistry();
  registry.register({ kind: 'deterministic', recoverySafety: () => 'safe', async execute() { world.update((state) => { state.prepare += 1; }); return { ok: true, statePatch: { proposal: { action: 'prepare-draft', target: 'account-a' } } }; } });
  registry.register(createApprovalNodeExecutor(approvals, () => alice));
  registry.register(createToolNodeExecutor({ tools, resolveAuthorizationContext: () => ({ schemaVersion: 1, principal: alice, grantedPermissionClasses: ['write_draft'] }) }));
  registry.register(finalOutputExecutor);
  return { host: createDurableRuntimeHost({ store, plan: compiled.plan, registry, approvals }), approvals, world };
}
