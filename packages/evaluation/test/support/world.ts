import type { PermissionClass, Principal } from "@aao/contracts";
import { createApprovalEngine, createApprovalNodeExecutor } from "@aao/approval";
import { createGovernanceRegistry } from "@aao/governance";
import { createAuditRecorder, createInMemoryAuditStore, createInMemoryTraceStore, createTraceRecorder } from "@aao/observability";
import { createNodeRegistry, finalOutputExecutor, type NodeExecutor, type RuntimeReliabilityOptions } from "@aao/runtime";
import { createToolNodeExecutor, createToolRegistry, type ToolHandlerResult } from "@aao/tool-runtime";
import { compileWorkflowSource, type CompiledWorkflowPlan } from "@aao/workflow-dsl";

/**
 * A real AAO world for Evaluation tests: compiled workflow, Node Registry,
 * Approval Engine, Tool Runtime with a handler spy, Governance, and real
 * Trace + Audit recorders. Evaluation only ever *reads* what this world
 * records; nothing in it imports @aao/evaluation.
 */
export const alice = { id: "user.alice", type: "user" } as const;
export const bob = { id: "user.bob", type: "user" } as const;
/** Sensitive fixture strings that must never appear in an EvalResult. */
export const STATE_SECRET = "FIXTURE_STATE_SECRET_DO_NOT_PERSIST";
export const TOOL_OUTPUT_SECRET = "FIXTURE_TOOL_OUTPUT_SECRET_api_key_0123";
export const APPROVAL_SUBJECT_SECRET = "FIXTURE_APPROVAL_SUBJECT_password_hunter2";

export function clockAt(startSecond: number) {
  let tick = startSecond;
  return { now: () => new Date(Date.UTC(2026, 9, 8, 12, 0, 0) + 1000 * tick++).toISOString() };
}

export function compile(yaml: string): CompiledWorkflowPlan {
  const compiled = compileWorkflowSource(yaml, "yaml");
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  return compiled.plan;
}

/** prepare → approval → lookup (retry-safe Tool) → final */
export const flagshipYaml = `
schemaVersion: 1
id: eval.flagship
version: "1.0.0"
name: Eval flagship
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
id: eval.tool
version: "1.0.0"
name: Eval tool
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
  toolScript?: ToolHandlerResult[];
  grants?: PermissionClass[];
  reliability?: RuntimeReliabilityOptions;
  requester?: Principal;
}

export function world(options: WorldOptions = {}) {
  const plan = options.plan ?? compile(flagshipYaml);
  const store = createInMemoryTraceStore();
  const recorder = createTraceRecorder({ store, clock: clockAt(0) });
  const auditStore = createInMemoryAuditStore();
  const audit = createAuditRecorder({ store: auditStore, clock: clockAt(500) });
  const governance = createGovernanceRegistry({
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
  const approvals = createApprovalEngine({ governance, clock: clockAt(100), audit });
  const calls: Array<{ toolExecutionId: string }> = [];
  const tools = createToolRegistry();
  tools.register({
    spec: { schemaVersion: 1, id: "local.lookup", version: "1.0.0", name: "Lookup", inputSchema: { type: "object" }, outputSchema: { type: "object" }, permissionClasses: ["read_only"] },
    retrySafety: "safe",
    handler: {
      async execute({ toolExecutionId }) {
        calls.push({ toolExecutionId });
        return options.toolScript?.[calls.length - 1] ?? { ok: true, output: { account: "account-a", apiKeyEcho: TOOL_OUTPUT_SECRET } };
      },
    },
  });
  const deterministic: NodeExecutor = {
    kind: "deterministic",
    recoverySafety: () => "safe",
    async execute() {
      return { ok: true, statePatch: { proposal: { action: "lookup", target: "account-a", note: APPROVAL_SUBJECT_SECRET }, internal: { credential: STATE_SECRET } } };
    },
  };
  const registry = createNodeRegistry();
  registry.register(deterministic);
  registry.register(createApprovalNodeExecutor(approvals, () => options.requester ?? alice));
  registry.register(createToolNodeExecutor({ tools, resolveAuthorizationContext: () => ({ schemaVersion: 1, principal: alice, grantedPermissionClasses: options.grants ?? ["read_only", "write_draft"] }), audit }));
  registry.register(finalOutputExecutor);
  const runtimeOptions = { clock: clockAt(0), sleeper: { sleep: async () => undefined }, trace: recorder, ...(options.reliability ? { reliability: options.reliability } : {}) };
  return { plan, store, recorder, auditStore, audit, approvals, registry, calls, tools, runtimeOptions };
}
