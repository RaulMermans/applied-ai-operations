import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { PermissionClass, Principal, TraceEvent } from "@aao/contracts";
import { createApprovalEngine, createApprovalNodeExecutor } from "@aao/approval";
import { createGovernanceRegistry } from "@aao/governance";
import { createNodeRegistry, finalOutputExecutor, type NodeExecutor, type RuntimeReliabilityOptions, type RuntimeSleeper } from "@aao/runtime";
import { createToolNodeExecutor, createToolRegistry, type ToolHandlerResult } from "@aao/tool-runtime";
import { compileWorkflowSource, type CompiledWorkflowPlan } from "@aao/workflow-dsl";
import { createAuditRecorder, createInMemoryTraceStore, createTraceRecorder, type AuditStore, type TraceStore } from "../src/index.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

export function tempRoot(prefix = "aao-trace-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** Deterministic ticking clock; a later "process" starts at a later offset, like real time. */
export function clockAt(startSecond: number) {
  let tick = startSecond;
  return { now: () => new Date(Date.UTC(2026, 9, 8, 12, 0, 0) + 1000 * tick++).toISOString() };
}

export const alice = { id: "user.alice", type: "user" } as const;
export const bob = { id: "user.bob", type: "user" } as const;
/** A secret that must never reach a trace. */
export const SECRET = "sk-live-TRACE-SECRET-0123456789";

export const governance = () =>
  createGovernanceRegistry({
    actors: [alice, bob],
    roles: [
      { id: "operator", version: "1.0.0", permissionClasses: ["read_only", "write_draft"] },
      { id: "manager", version: "1.0.0", permissionClasses: ["read_only"] },
    ],
    bindings: [
      { id: "alice.operator", actorId: alice.id, roleId: "operator", status: "active" },
      { id: "bob.manager", actorId: bob.id, roleId: "manager", status: "active" },
    ],
    policies: [],
  });

export function compile(yaml: string): CompiledWorkflowPlan {
  const compiled = compileWorkflowSource(yaml, "yaml");
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  return compiled.plan;
}

/** prepare → approval → lookup (Tool) → final */
export const flagshipYaml = `
schemaVersion: 1
id: trace.flagship
version: "1.0.0"
name: Trace flagship
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

/** lookup (Tool) → final */
export const toolYaml = `
schemaVersion: 1
id: trace.tool
version: "1.0.0"
name: Trace tool
entryNodeId: lookup
nodes:
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
  - { sourceNodeId: lookup, targetNodeId: final }
`;

export const TRANSIENT: ToolHandlerResult = { ok: false, code: "UPSTREAM_UNAVAILABLE", retryable: true };

export interface WorldOptions {
  plan?: CompiledWorkflowPlan;
  store?: TraceStore;
  traceClock?: { now(): string };
  toolScript?: Array<ToolHandlerResult | (() => Promise<ToolHandlerResult>)>;
  toolPermission?: PermissionClass;
  toolRetrySafety?: "safe";
  toolIdempotency?: "execution_id";
  grants?: PermissionClass[];
  reliability?: RuntimeReliabilityOptions;
  sleeper?: RuntimeSleeper;
  tracing?: boolean;
  /** Sprint 16: wire an Audit recorder over this store into the Approval Engine and Tool Node. */
  auditStore?: AuditStore;
  auditClock?: { now(): string };
  /** One shared clock for Runtime, Trace, Approval, and Audit (resolution-time tests). */
  clock?: { now(): string };
  requester?: Principal;
}

/** Everything one "process" builds from scratch: registries, approval engine, Tool with a call spy, trace store and recorder. */
export function world(options: WorldOptions = {}) {
  const plan = options.plan ?? compile(flagshipYaml);
  const store = options.store ?? createInMemoryTraceStore();
  const recorder = createTraceRecorder({ store, clock: options.traceClock ?? options.clock ?? clockAt(0) });
  const auditRecorder = options.auditStore ? createAuditRecorder({ store: options.auditStore, clock: options.auditClock ?? options.clock ?? clockAt(500) }) : undefined;
  const approvals = createApprovalEngine({ governance: governance(), clock: options.clock ?? clockAt(100), ...(auditRecorder ? { audit: auditRecorder } : {}) });
  const calls: Array<{ toolExecutionId: string; input: unknown }> = [];
  const tools = createToolRegistry();
  tools.register({
    spec: { schemaVersion: 1, id: "local.lookup", version: "1.0.0", name: "Lookup", inputSchema: { type: "object" }, outputSchema: { type: "object" }, permissionClasses: [options.toolPermission ?? "read_only"] },
    ...(options.toolRetrySafety ? { retrySafety: options.toolRetrySafety } : {}),
    ...(options.toolIdempotency ? { idempotency: options.toolIdempotency } : {}),
    handler: {
      async execute({ toolExecutionId, input }) {
        calls.push({ toolExecutionId, input });
        const scripted = options.toolScript?.[calls.length - 1];
        if (typeof scripted === "function") return scripted();
        return scripted ?? { ok: true, output: { account: "account-a", apiKeyEcho: SECRET } };
      },
    },
  });
  const deterministic: NodeExecutor = {
    kind: "deterministic",
    recoverySafety: () => "safe",
    async execute() {
      return { ok: true, statePatch: { proposal: { action: "lookup", target: "account-a", credential: SECRET } } };
    },
  };
  const registry = createNodeRegistry();
  registry.register(deterministic);
  registry.register(createApprovalNodeExecutor(approvals, () => options.requester ?? alice));
  registry.register(createToolNodeExecutor({ tools, resolveAuthorizationContext: () => ({ schemaVersion: 1, principal: alice, grantedPermissionClasses: options.grants ?? ["read_only", "write_draft"] }), ...(auditRecorder ? { audit: auditRecorder } : {}) }));
  registry.register(finalOutputExecutor);
  const runtimeOptions = {
    clock: options.clock ?? clockAt(0),
    sleeper: options.sleeper ?? { sleep: async () => undefined },
    ...(options.reliability ? { reliability: options.reliability } : {}),
    ...(options.tracing === false ? {} : { trace: recorder }),
  };
  return { plan, store, recorder, auditRecorder, approvals, registry, calls, runtimeOptions, tools };
}

/** `type@node` labels, in sequence order — readable trajectory assertions. */
export function trajectory(events: readonly TraceEvent[]): string[] {
  return events.map((event) => (event.nodeId ? `${event.type}@${event.nodeId}` : event.type));
}

export function ofType(events: readonly TraceEvent[], type: string): TraceEvent[] {
  return events.filter((event) => event.type === type);
}
