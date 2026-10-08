// Shared construction for the Sprint 16 compiled Metrics + Audit smoke. Uses
// only built `dist/` output. Every phase builds its stores, recorders,
// registries, and hosts from scratch, so a separate Node process proves
// restart behavior.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApprovalEngine, createApprovalNodeExecutor } from '@aao/approval';
import { createDurableRuntimeHost, createFileDurabilityStore } from '@aao/durability';
import { createGovernanceRegistry } from '@aao/governance';
import { createNodeRegistry, finalOutputExecutor } from '@aao/runtime';
import { createToolNodeExecutor, createToolRegistry } from '@aao/tool-runtime';
import { compileWorkflowSource } from '@aao/workflow-dsl';
import { createAuditRecorder, createFileAuditStore, createFileTraceStore, createTraceRecorder } from '../../dist/index.js';

export const runId = 'run.smoke.s16';
export const alice = { id: 'user.alice', type: 'user' };
export const bob = { id: 'user.bob', type: 'user' };
export const SECRET = 'sk-live-S16-SMOKE-SECRET';

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export const yaml = `
schemaVersion: 1
id: smoke.s16
version: "1.0.0"
name: Smoke metrics and audit
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

/** A clock that moves only when told: lets the smoke separate decision time (T1) from continuation time (T2). */
export function manualClock(startIso) {
  let now = Date.parse(startIso);
  return { now: () => new Date(now).toISOString(), advance: (ms) => { now += ms; } };
}

/** File-backed handler call log: physical Tool calls survive process death, like a real downstream system. */
function fileCalls(root) {
  const path = join(root, 'tool-calls.json');
  const read = () => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []);
  return { read, push: (entry) => writeFileSync(path, JSON.stringify([...read(), entry])) };
}

export function memoryCalls() {
  const entries = [];
  return { read: () => [...entries], push: (entry) => entries.push(entry) };
}

/** Governance, an audit-wired Approval Engine, a read_only retry-safe Tool whose first physical call fails transiently, and the node registry. */
export function components({ clock, audit, repository, log }) {
  const compiled = compileWorkflowSource(yaml, 'yaml');
  if (!compiled.ok) throw new Error('Compilation failed');
  const governance = createGovernanceRegistry({
    actors: [alice, bob],
    roles: [{ id: 'operator', version: '1.0.0', permissionClasses: ['read_only'] }, { id: 'manager', version: '1.0.0', permissionClasses: ['read_only'] }],
    bindings: [{ id: 'alice.operator', actorId: alice.id, roleId: 'operator', status: 'active' }, { id: 'bob.manager', actorId: bob.id, roleId: 'manager', status: 'active' }],
    policies: [],
  });
  const approvals = createApprovalEngine({ governance, clock, audit, ...(repository ? { repository } : {}) });
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
  registry.register(createToolNodeExecutor({ tools, resolveAuthorizationContext: () => ({ schemaVersion: 1, principal: alice, grantedPermissionClasses: ['read_only'] }), audit }));
  registry.register(finalOutputExecutor);
  return { approvals, registry, plan: compiled.plan };
}

export const reliability = { policiesByNodeId: { lookup: { maxAttempts: 3 } } };

/** One durable "process": file durability, Trace, and Audit stores over a shared root, rebuilt from scratch. */
export function build(root, clock) {
  const store = createFileDurabilityStore({ root: join(root, 'durability') });
  const auditStore = createFileAuditStore({ root: join(root, 'audit') });
  const audit = createAuditRecorder({ store: auditStore, clock });
  const log = fileCalls(root);
  const { approvals, registry, plan } = components({ clock, audit, repository: store.approvals, log });
  const traceStore = createFileTraceStore({ root: join(root, 'trace') });
  const trace = createTraceRecorder({ store: traceStore, clock });
  const host = createDurableRuntimeHost({ store, plan, registry, approvals, clock, sleeper: { sleep: async () => undefined }, reliability, trace, audit });
  return { host, approvals, trace, traceStore, audit, auditStore, toolCalls: () => log.read() };
}
