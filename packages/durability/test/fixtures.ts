import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { PermissionClass, RunState, ToolIdempotency } from "@aao/contracts";
import { createApprovalEngine, createApprovalNodeExecutor } from "@aao/approval";
import { createGovernanceRegistry, type GovernanceRegistry } from "@aao/governance";
import { createNodeRegistry, finalOutputExecutor, type NodeExecutor, type RuntimeReliabilityOptions } from "@aao/runtime";
import { createToolNodeExecutor, createToolRegistry, type ToolHandlerResult } from "@aao/tool-runtime";
import { compileWorkflowSource, type CompiledWorkflowPlan } from "@aao/workflow-dsl";
import { DurabilityError, createDurableRuntimeHost, createFileDurabilityStore, type DurabilityStore } from "../src/index.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** An isolated temporary durability root, removed after each test. */
export function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "aao-durability-"));
  roots.push(root);
  return root;
}

/** A deterministic, ticking clock. Separate "processes" in a test use later start offsets, like real time. */
export function clockAt(startSecond: number) {
  let tick = startSecond;
  return { now: () => new Date(Date.UTC(2026, 9, 8, 12, 0, 0) + 1000 * tick++).toISOString() };
}

export const alice = { id: "user.alice", type: "user" } as const;
export const bob = { id: "user.bob", type: "user" } as const;

export function governance(options: { aliceOperator?: boolean; bobManager?: boolean } = {}): GovernanceRegistry {
  return createGovernanceRegistry({
    actors: [alice, bob],
    roles: [
      { id: "operator", version: "1.0.0", permissionClasses: ["read_only", "write_draft"] },
      { id: "manager", version: "1.0.0", permissionClasses: ["read_only"] },
    ],
    bindings: [
      { id: "alice.operator", actorId: alice.id, roleId: "operator", status: options.aliceOperator === false ? "inactive" : "active" },
      { id: "bob.manager", actorId: bob.id, roleId: "manager", status: options.bobManager === false ? "inactive" : "active" },
    ],
    policies: [],
  });
}

export function compile(yaml: string): CompiledWorkflowPlan {
  const compiled = compileWorkflowSource(yaml, "yaml");
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  return compiled.plan;
}

/** prepare → approval → draft (Tool) → final */
export const approvalYaml = `
schemaVersion: 1
id: durable.approval
version: "1.0.0"
name: Durable approval
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

/** a → b → c → final, all deterministic */
export const linearYaml = `
schemaVersion: 1
id: durable.linear
version: "1.0.0"
name: Durable linear
entryNodeId: a
nodes:
  - id: a
    kind: deterministic
    config: {}
  - id: b
    kind: deterministic
    config: {}
  - id: c
    kind: deterministic
    config: {}
  - id: final
    kind: final_output
    config: {}
edges:
  - { sourceNodeId: a, targetNodeId: b }
  - { sourceNodeId: b, targetNodeId: c }
  - { sourceNodeId: c, targetNodeId: final }
`;

/** tool → final */
export const toolYaml = `
schemaVersion: 1
id: durable.tool
version: "1.0.0"
name: Durable tool
entryNodeId: work
nodes:
  - id: work
    kind: tool
    config:
      toolRef: { id: local.draft, version: "1.0.0" }
      inputStateKey: request
      resultStateKey: workResult
  - id: final
    kind: final_output
    config: {}
edges:
  - { sourceNodeId: work, targetNodeId: final }
`;

/**
 * Durable "external" effects outlive any one host: they belong to the test,
 * like a real downstream system. `logicalDrafts` is keyed by the AAO
 * `toolExecutionId`, the way an idempotent implementation would dedupe.
 */
export function createEffects() {
  return {
    executions: {} as Record<string, number>,
    toolCalls: 0,
    toolExecutionIds: [] as string[],
    logicalDrafts: new Map<string, number>(),
  };
}
export type Effects = ReturnType<typeof createEffects>;

export interface WorldOptions {
  yaml?: string;
  root: string;
  effects: Effects;
  clock: { now(): string };
  store?: DurabilityStore;
  governance?: GovernanceRegistry;
  toolPermission?: PermissionClass;
  toolIdempotency?: ToolIdempotency;
  toolRetrySafety?: "safe";
  toolScript?: ToolHandlerResult[];
  deterministicRecoverySafe?: boolean;
  deterministicFailures?: Record<string, Array<{ code: string; category: "TRANSIENT_DEPENDENCY" | "EXECUTION" }>>;
  reliability?: RuntimeReliabilityOptions;
  plan?: CompiledWorkflowPlan;
}

/** Everything one "process" constructs from scratch: store, approval engine, registries, and the durable host. */
export function world(options: WorldOptions) {
  const { effects } = options;
  const plan = options.plan ?? compile(options.yaml ?? approvalYaml);
  const store = options.store ?? createFileDurabilityStore({ root: options.root });
  const approvals = createApprovalEngine({ governance: options.governance ?? governance(), clock: options.clock, repository: store.approvals });
  const tools = createToolRegistry();
  tools.register({
    spec: { schemaVersion: 1, id: "local.draft", version: "1.0.0", name: "Draft", inputSchema: { type: "object" }, outputSchema: { type: "object" }, permissionClasses: [options.toolPermission ?? "write_draft"] },
    ...(options.toolIdempotency ? { idempotency: options.toolIdempotency } : {}),
    ...(options.toolRetrySafety ? { retrySafety: options.toolRetrySafety } : {}),
    handler: {
      async execute({ toolExecutionId }) {
        effects.toolCalls += 1;
        effects.toolExecutionIds.push(toolExecutionId);
        const scripted = options.toolScript?.[effects.toolCalls - 1];
        if (scripted) return scripted;
        // An implementation honoring the execution-id contract dedupes on toolExecutionId.
        if (!effects.logicalDrafts.has(toolExecutionId)) effects.logicalDrafts.set(toolExecutionId, effects.logicalDrafts.size + 1);
        return { ok: true, output: { draftNumber: effects.logicalDrafts.get(toolExecutionId)! } };
      },
    },
  });
  const deterministic: NodeExecutor = {
    kind: "deterministic",
    retrySafety: () => "safe",
    ...(options.deterministicRecoverySafe === false ? {} : { recoverySafety: () => "safe" as const }),
    async execute({ node }) {
      const count = (effects.executions[node.id] ?? 0) + 1;
      effects.executions[node.id] = count;
      const failure = options.deterministicFailures?.[node.id]?.[count - 1];
      if (failure) return { ok: false, failure: { namespace: "test", code: failure.code, category: failure.category } };
      return { ok: true, statePatch: node.id === "prepare" ? { proposal: { action: "prepare-draft", target: "account-a" } } : { [node.id]: count }, output: { node: node.id } };
    },
  };
  const approvalExecutor = createApprovalNodeExecutor(approvals, () => alice);
  const registry = createNodeRegistry();
  registry.register(deterministic);
  registry.register({ ...approvalExecutor, async execute(context) { effects.executions.approval = (effects.executions.approval ?? 0) + 1; return approvalExecutor.execute(context); } });
  registry.register(createToolNodeExecutor({ tools, resolveAuthorizationContext: () => ({ schemaVersion: 1, principal: alice, grantedPermissionClasses: ["read_only", "write_draft", "external_side_effect", "destructive", "sensitive_data"] }) }));
  registry.register(finalOutputExecutor);
  const host = createDurableRuntimeHost({ store, plan, registry, approvals, clock: options.clock, ...(options.reliability ? { reliability: options.reliability } : {}), sleeper: { sleep: async () => undefined } });
  return { plan, store, approvals, registry, host };
}

export const initial = (runId: string, values: RunState["values"] = {}): RunState => ({ runId, revision: 0, values });

type StoreMethod = Exclude<keyof DurabilityStore, "approvals">;

/**
 * Simulates a crash at one durability write: the named store method rejects
 * once (when `when` matches), the way a process dying at that instant would
 * leave the store. The host is then discarded and a new one is constructed.
 */
export function crashingStore(store: DurabilityStore, method: StoreMethod, when: (...args: never[]) => boolean = () => true): DurabilityStore & { crashed: () => boolean } {
  let crashed = false;
  const original = store[method] as (...args: unknown[]) => Promise<unknown>;
  return {
    ...store,
    approvals: store.approvals,
    [method]: (...args: unknown[]) => {
      if (!crashed && (when as (...a: unknown[]) => boolean)(...args)) {
        crashed = true;
        return Promise.reject(new DurabilityError("DURABILITY_IO_FAILED"));
      }
      return original(...args);
    },
    crashed: () => crashed,
  } as DurabilityStore & { crashed: () => boolean };
}
