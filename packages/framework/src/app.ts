import { createHash } from "node:crypto";
import { createAgentNodeExecutor } from "@aao/agent-runtime";
import { createApprovalEngine, createApprovalNodeExecutor, continueApprovedWorkflow } from "@aao/approval";
import { authorizationContextFromAuthority, type AuthorizationContext } from "@aao/authorization";
import { canonicalJsonStringify, type ApprovalRecord, type GovernanceConfiguration, type JsonValue, type ModelPolicySpec, type NodeKind, type Principal, type ReliabilityPolicy, type RunState, type Workflow } from "@aao/contracts";
import { createGovernanceRegistry, resolveAuthority, type GovernanceRegistry } from "@aao/governance";
import { createModelNodeExecutor, type ModelAdapterDefinition } from "@aao/model-runtime";
import { createDeterministicNodeExecutor, createNodeRegistry, createSystemClock, executeWorkflow, finalOutputExecutor, type DeterministicExecutor, type NodeExecutor, type RuntimeClock, type RuntimeExecutionState, type RuntimeTracePort, type WorkflowExecutionResult } from "@aao/runtime";
import { createToolNodeExecutor, createToolRegistry, type ToolAuthorizationTarget, type ToolRegistry } from "@aao/tool-runtime";
import { compileWorkflow } from "@aao/workflow-dsl";
import { defineGovernance, defineWorkflow, type ToolDefinition } from "./definitions.js";
import { AAOFrameworkError } from "./errors.js";
import { deepFreeze, registrationFailure } from "./internal.js";
import { composeModels, type AgentDefinition, type ModelBindingDefinition } from "./models.js";
import { AAO_FRAMEWORK_API_VERSION } from "./version.js";

/**
 * The trusted host's identity boundary. AAO asks the host — and only the
 * host — which principal a Run acts for. It receives the Run id and nothing
 * else: never workflow state, node config, Tool input, model output, or MCP
 * metadata, so none of those can establish identity.
 */
export type PrincipalForRun = (context: { readonly runId: string }) => Principal;

/** The explicit time boundary (`RuntimeClock`). Defaults to the system clock; inject one for deterministic timestamps. */
export interface AAOClock {
  now(): string;
}

export interface AAOOptions {
  /** Canonical Governance configuration (see `defineGovernance`). */
  governance: GovernanceConfiguration;
  /** Required. The only source of the acting principal for Tool Authorization and Approval requests. */
  principalForRun: PrincipalForRun;
  /** Tools registered once, at construction. Duplicate `id@version` fails construction. */
  tools?: readonly ToolDefinition[];
  /**
   * Model adapters (`defineModelAdapter`: an `AdapterManifest` plus the
   * canonical `ModelAdapter` port), registered once by exact `id@version`.
   * A concrete adapter (Vercel AI SDK, for example) is imported by the host
   * from its own package, never from `@aao/framework`.
   */
  modelAdapters?: readonly ModelAdapterDefinition[];
  /** Model bindings naming an exact `adapterRef`. Each binding's capabilities must be declared supported by its adapter. */
  modelBindings?: readonly ModelBindingDefinition[];
  /** Canonical Model Policies that `model` nodes and Agents reference by id. Routing stays the Model Runtime's. */
  modelPolicies?: readonly ModelPolicySpec[];
  /** Bounded Agents for `agent` nodes, executed by the canonical Agent Runtime only. */
  agents?: readonly AgentDefinition[];
  /** Trusted host code for `deterministic` nodes, referenced by exact `executorRef`. Not an adapter. */
  deterministicExecutors?: readonly DeterministicExecutor[];
  /** Optional emit-only Trace port (e.g. an `@aao/observability` recorder). Observational only: it never changes an outcome. */
  trace?: RuntimeTracePort;
  clock?: AAOClock;
}

export interface ExecuteWorkflowInput {
  /** Caller-owned Run identity. */
  runId: string;
  /** Canonical initial `RunState` (`{ runId, revision: 0, values }`). */
  initialState: RunState;
}

/**
 * A compiled, immutable Workflow bound to one application. It holds no Run
 * state: every call returns the canonical `WorkflowExecutionResult`, whose
 * `execution` (`RuntimeExecutionState`) stays the only authoritative state.
 */
export interface PreparedWorkflow {
  readonly workflow: Workflow;
  /** SHA-256 of the canonical compiled plan: identical definitions prepare identically. */
  readonly planFingerprint: string;
  /** Runs the Workflow through the canonical Runtime. Failures are returned as Runtime values, never rewrapped. */
  execute(input: ExecuteWorkflowInput): Promise<WorkflowExecutionResult>;
  /** Continues a Run waiting for Approval through the canonical Approval bridge. A still-pending Approval stays a canonical failure. */
  continue(execution: RuntimeExecutionState): Promise<WorkflowExecutionResult>;
}

/** A small façade over the canonical Approval Engine. Records are immutable; there is no direct mutation. */
export interface AAOApprovals {
  get(approvalId: string): ApprovalRecord | undefined;
  /** `approver` is a host-attested human principal. Eligibility and self-approval rules are the Approval Engine's; its canonical `ApprovalError` (with `code`) is thrown unchanged. */
  approve(approvalId: string, approver: Principal): ApprovalRecord;
  reject(approvalId: string, approver: Principal): ApprovalRecord;
}

/**
 * Trusted host execution options for one prepared Workflow. They are never
 * read from Workflow source or state. `reliability` is the Runtime's own
 * per-node `ReliabilityPolicy` (bounded attempts, attempt timeout). The
 * canonical Runtime validates it at execution, and an invalid policy is the
 * Runtime's canonical failure, never a Framework one.
 */
export interface PrepareWorkflowOptions {
  reliability?: { policiesByNodeId: Readonly<Record<string, ReliabilityPolicy>> };
}

export interface AAOApp {
  readonly apiVersion: typeof AAO_FRAMEWORK_API_VERSION;
  /** Compiles a canonical Workflow (no second compiler) into a `PreparedWorkflow`. Throws `AAOFrameworkError` on preparation failures only. */
  prepareWorkflow(workflow: Workflow, options?: PrepareWorkflowOptions): PreparedWorkflow;
  readonly approvals: AAOApprovals;
}

/**
 * Node kinds the Framework executes. Since Sprint 20 (ADR-025) `model` and
 * `agent` run through the stable adapter contract, and `deterministic`
 * runs through registered trusted host executors. `evaluator` nodes have
 * no executor and are refused at preparation instead of failing later.
 */
const SUPPORTED_NODE_KINDS: readonly NodeKind[] = ["tool", "approval", "model", "agent", "deterministic", "final_output"];

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJsonStringify(value as JsonValue), "utf8").digest("hex");
}

/**
 * Host-attested Authorization Context for one Tool Node execution, through
 * the canonical path only: host principal → `resolveAuthority` (Governance)
 * → `authorizationContextFromAuthority`. An unregistered principal has no
 * authority and yields `undefined`, which the Tool Runtime fails closed
 * (`TOOL_AUTHORIZATION_REQUIRED`). The allow/deny decision itself is still
 * `authorize()`, inside `executeTool`.
 */
function governedAuthorization(governance: GovernanceRegistry, tools: ToolRegistry, principalForRun: PrincipalForRun) {
  return (target: ToolAuthorizationTarget): AuthorizationContext | undefined => {
    const spec = tools.getSpec(target.toolRef);
    if (spec === undefined) return undefined;
    const principal = principalForRun(Object.freeze({ runId: target.runId }));
    const decision = resolveAuthority(governance, principal, spec.permissionClasses);
    return decision.authority === undefined ? undefined : authorizationContextFromAuthority(decision.authority);
  };
}

/**
 * Constructs one isolated AAO application: validate → register → freeze →
 * execute. Composes only existing AAO Core: a Governance registry, a Tool
 * Registry, a Model Registry and Model Policy Registry, an Agent Registry,
 * an Approval Engine, and a Node Registry with the canonical Tool, Model,
 * Agent, deterministic, Approval, and `final_output` executors. There is no
 * global registry, no environment or filesystem discovery, no plugin
 * loading, and no adapter discovery. Registration is construction-time only.
 */
export function createAAO(options: AAOOptions): AAOApp {
  if (options === null || typeof options !== "object") throw new AAOFrameworkError("FRAMEWORK_INVALID_CONFIGURATION", "createAAO requires an options object");
  const principalForRun = options.principalForRun;
  if (typeof principalForRun !== "function") throw new AAOFrameworkError("FRAMEWORK_PRINCIPAL_UNAVAILABLE", "createAAO requires a principalForRun function: identity comes only from the trusted host");
  const clock: RuntimeClock = options.clock ?? createSystemClock();
  if (typeof clock?.now !== "function") throw new AAOFrameworkError("FRAMEWORK_INVALID_CONFIGURATION", "clock must provide now()");
  if (options.tools !== undefined && !Array.isArray(options.tools)) throw new AAOFrameworkError("FRAMEWORK_INVALID_CONFIGURATION", "tools must be an array");
  if (options.deterministicExecutors !== undefined && !Array.isArray(options.deterministicExecutors)) throw new AAOFrameworkError("FRAMEWORK_INVALID_CONFIGURATION", "deterministicExecutors must be an array");
  const trace = options.trace;
  if (trace !== undefined && typeof trace?.emit !== "function") throw new AAOFrameworkError("FRAMEWORK_INVALID_CONFIGURATION", "trace must provide emit()");

  let governance: GovernanceRegistry;
  try {
    governance = createGovernanceRegistry(defineGovernance(options.governance));
  } catch (error) {
    if (error instanceof AAOFrameworkError) throw new AAOFrameworkError("FRAMEWORK_INVALID_CONFIGURATION", error.message.slice(`${error.code}: `.length), error.diagnostics);
    throw registrationFailure("FRAMEWORK_INVALID_CONFIGURATION", "governance", error);
  }

  const tools = createToolRegistry();
  for (const tool of [...(options.tools ?? [])]) {
    try {
      // Only the canonical RegisteredTool fields; the Tool Registry re-validates, clones the spec, and captures the handler.
      const { spec, handler, retrySafety, idempotency } = tool;
      tools.register({ spec, handler, ...(retrySafety !== undefined ? { retrySafety } : {}), ...(idempotency !== undefined ? { idempotency } : {}) });
    } catch (error) {
      throw registrationFailure("FRAMEWORK_INVALID_CONFIGURATION", "tool registration", error);
    }
  }

  const { models, policies, agents } = composeModels(options);
  let deterministic: NodeExecutor;
  try {
    deterministic = createDeterministicNodeExecutor(options.deterministicExecutors ?? []);
  } catch (error) {
    throw registrationFailure("FRAMEWORK_INVALID_CONFIGURATION", "deterministic executor", error);
  }

  const approvalEngine = createApprovalEngine({ governance, clock });
  const nodes = createNodeRegistry();
  nodes.register(createToolNodeExecutor({ tools, resolveAuthorizationContext: governedAuthorization(governance, tools, principalForRun) }));
  nodes.register(createApprovalNodeExecutor(approvalEngine, (runId) => principalForRun(Object.freeze({ runId }))));
  nodes.register(createModelNodeExecutor({ models, policies }));
  nodes.register(createAgentNodeExecutor({ agents, models, policies }));
  nodes.register(deterministic);
  nodes.register(finalOutputExecutor);
  const runtimeOptions = Object.freeze({ clock, ...(trace !== undefined ? { trace } : {}) });

  function prepareWorkflow(input: Workflow, prepareOptions?: PrepareWorkflowOptions): PreparedWorkflow {
    const workflow = defineWorkflow(input);
    const compiled = compileWorkflow(workflow);
    if (!compiled.ok) throw new AAOFrameworkError("FRAMEWORK_WORKFLOW_COMPILE_FAILED", `workflow ${workflow.id}@${workflow.version} does not compile`, compiled.diagnostics);
    const unsupported = workflow.nodes.filter((node) => !SUPPORTED_NODE_KINDS.includes(node.kind));
    if (unsupported.length > 0) {
      throw new AAOFrameworkError(
        "FRAMEWORK_FEATURE_NOT_AVAILABLE",
        `Framework V1 executes ${SUPPORTED_NODE_KINDS.join(", ")} nodes only`,
        unsupported.map((node) => ({ code: "NODE_KIND_NOT_AVAILABLE", message: `node kind "${node.kind}" is not executable through @aao/framework yet`, nodeId: node.id })),
      );
    }
    // The plan stays private to this closure: no caller reference can reach what the Runtime executes.
    const plan = compiled.plan;
    // Snapshotted now (JSON copy), so later caller mutation cannot change a prepared Workflow's policy.
    const policies = prepareOptions?.reliability?.policiesByNodeId;
    const options = policies === undefined ? runtimeOptions : Object.freeze({ ...runtimeOptions, reliability: { policiesByNodeId: JSON.parse(JSON.stringify(policies)) as Record<string, ReliabilityPolicy> } });
    const planFingerprint = sha256(plan);
    return Object.freeze({
      workflow,
      planFingerprint,
      execute: (request: ExecuteWorkflowInput) => executeWorkflow({ runId: request?.runId, initialState: request?.initialState, plan, registry: nodes, options }),
      continue: (execution: RuntimeExecutionState) => continueApprovedWorkflow(approvalEngine, { plan, registry: nodes, execution, options }),
    });
  }

  const approvals: AAOApprovals = Object.freeze({
    get: (approvalId: string) => approvalEngine.getApproval(approvalId),
    approve: (approvalId: string, approver: Principal) => approvalEngine.approve(approvalId, approver),
    reject: (approvalId: string, approver: Principal) => approvalEngine.reject(approvalId, approver),
  });

  return deepFreeze({ apiVersion: AAO_FRAMEWORK_API_VERSION, prepareWorkflow, approvals });
}
