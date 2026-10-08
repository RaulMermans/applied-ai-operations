// Shared construction for the Sprint 15 compiled Trace smokes. Uses only
// built `dist/` output. Every phase builds its stores, recorder, registries,
// and hosts from scratch, so a separate Node process proves restart behavior.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApprovalEngine, createApprovalNodeExecutor } from '@aao/approval';
import { createDurableRuntimeHost, createFileDurabilityStore } from '@aao/durability';
import { createGovernanceRegistry } from '@aao/governance';
import { createNodeRegistry, finalOutputExecutor } from '@aao/runtime';
import { createToolNodeExecutor, createToolRegistry } from '@aao/tool-runtime';
import { compileWorkflowSource } from '@aao/workflow-dsl';
import { createFileTraceStore, createTraceRecorder } from '../dist/index.js';

export const runId = 'run.smoke.trace';
export const alice = { id: 'user.alice', type: 'user' };
export const bob = { id: 'user.bob', type: 'user' };
export const SECRET = 'sk-live-SMOKE-SECRET-42';

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export const yaml = `
schemaVersion: 1
id: smoke.trace
version: "1.0.0"
name: Smoke trace runtime
entryNodeId: prepare
nodes:
  - id: prepare
    kind: deterministic
    config: {}
  - id: approval
    kind: approval
    config:
      subjectStateKey: proposal
      permissionClasses: [read_only]
      requiredApproverRoleIds: [manager]
  - id: lookup
    kind: tool
    config:
      toolRef: { id: local.lookup, version: "1.0.0" }
      inputStateKey: proposal
      resultStateKey: lookupResult
  - id: final
    kind: final_output
    config: {}
edges:
  - { sourceNodeId: prepare, targetNodeId: approval }
  - { sourceNodeId: approval, targetNodeId: lookup }
  - { sourceNodeId: lookup, targetNodeId: final }
`;

export function clockAt(start) {
  let tick = start;
  return { now: () => new Date(Date.UTC(2026, 9, 8, 12, 0, 0) + 1000 * tick++).toISOString() };
}

/** File-backed handler call log: physical Tool calls survive process death, like a real downstream system. */
function calls(root) {
  const path = join(root, 'tool-calls.json');
  const read = () => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []);
  return { read, push: (entry) => writeFileSync(path, JSON.stringify([...read(), entry])) };
}

/** A read_only, retry-safe lookup Tool whose first call fails transiently. */
export function build(root, start) {
  const compiled = compileWorkflowSource(yaml, 'yaml');
  if (!compiled.ok) throw new Error('Compilation failed');
  const governance = createGovernanceRegistry({
    actors: [alice, bob],
    roles: [{ id: 'operator', version: '1.0.0', permissionClasses: ['read_only'] }, { id: 'manager', version: '1.0.0', permissionClasses: ['read_only'] }],
    bindings: [{ id: 'alice.operator', actorId: alice.id, roleId: 'operator', status: 'active' }, { id: 'bob.manager', actorId: bob.id, roleId: 'manager', status: 'active' }],
    policies: [],
  });
  const store = createFileDurabilityStore({ root: join(root, 'durability') });
  const approvals = createApprovalEngine({ governance, clock: clockAt(start), repository: store.approvals });
  const log = calls(root);
  const tools = createToolRegistry();
  tools.register({
    spec: { schemaVersion: 1, id: 'local.lookup', version: '1.0.0', name: 'Lookup', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, permissionClasses: ['read_only'] },
    retrySafety: 'safe',
    handler: {
      async execute({ toolExecutionId }) {
        log.push(toolExecutionId);
        return log.read().length === 1 ? { ok: false, code: 'UPSTREAM_UNAVAILABLE', retryable: true } : { ok: true, output: { account: 'account-a', echo: SECRET } };
      },
    },
  });
  const registry = createNodeRegistry();
  registry.register({ kind: 'deterministic', recoverySafety: () => 'safe', async execute() { return { ok: true, statePatch: { proposal: { target: 'account-a', credential: SECRET } } }; } });
  registry.register(createApprovalNodeExecutor(approvals, () => alice));
  registry.register(createToolNodeExecutor({ tools, resolveAuthorizationContext: () => ({ schemaVersion: 1, principal: alice, grantedPermissionClasses: ['read_only'] }) }));
  registry.register(finalOutputExecutor);
  const traceStore = createFileTraceStore({ root: join(root, 'trace') });
  const recorder = createTraceRecorder({ store: traceStore, clock: clockAt(start) });
  const host = createDurableRuntimeHost({ store, plan: compiled.plan, registry, approvals, clock: clockAt(start), sleeper: { sleep: async () => undefined }, reliability: { policiesByNodeId: { lookup: { maxAttempts: 3 } } }, trace: recorder });
  return { host, approvals, recorder, traceStore, registry, plan: compiled.plan, toolCalls: () => log.read() };
}

export const labels = (events) => events.map((event) => (event.nodeId ? `${event.type}@${event.nodeId}` : event.type));
