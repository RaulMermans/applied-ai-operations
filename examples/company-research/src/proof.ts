import { createAAO, defineModelPolicy, type AAOClock, type GovernanceConfiguration, type JsonValue, type ModelAdapterDefinition, type ModelBindingDefinition, type ModelPolicySpec, type PrincipalForRun, type ReliabilityPolicy, type RuntimeFailure, type RuntimeTracePort, type ToolDefinition, type Workflow, type WorkflowExecutionResult } from "@aao/framework";
import { createPublicWebTools, type PublicWebProvider } from "@aao/integration-public-web";
import { coreToolbox, selectToolboxTools } from "@aao/toolbox";
import type { CompanyResearchRequestInput, CompanyResearchResult } from "./contracts.js";
import { COMPANY_RESEARCH_EXECUTORS, STATE_KEYS } from "./executors.js";
import { PLANNING_POLICY_REF, SYNTHESIS_POLICY_REF } from "./model-requests.js";
import { DEDUPE_TOOL_REF, PROJECT_TOOL_REF, companyResearchWorkflow } from "./workflow.js";

/** The proof's two canonical Model Policies. Routing to a binding is the Model Runtime's; no vendor is named. */
export const COMPANY_RESEARCH_MODEL_POLICIES: readonly ModelPolicySpec[] = Object.freeze([
  defineModelPolicy({ schemaVersion: 1, id: PLANNING_POLICY_REF, version: "1.0.0", name: "Company research planning", requiredCapabilities: ["model.structured_output"] }),
  defineModelPolicy({ schemaVersion: 1, id: SYNTHESIS_POLICY_REF, version: "1.0.0", name: "Company research synthesis", requiredCapabilities: ["model.structured_output"] }),
]);

export interface CompanyResearchProofOptions {
  /** Model adapters (`defineModelAdapter`), supplied by the host. */
  modelAdapters: readonly ModelAdapterDefinition[];
  /** Host model bindings; each needs `model.structured_output`. */
  modelBindings: readonly ModelBindingDefinition[];
  /** The host's public-web provider. The Workflow never names it. */
  researchProvider: PublicWebProvider;
  /** Canonical Governance. The Run's principal needs `read_only`; nothing else is needed or used. */
  governance: GovernanceConfiguration;
  /** The host's identity boundary, exactly as for `createAAO`. */
  principalForRun: PrincipalForRun;
  /** Optional explicit Tool list override for registration testing. */
  tools?: readonly ToolDefinition[];
  /** Optional explicit Model Policy list override for registration testing. */
  modelPolicies?: readonly ModelPolicySpec[];
  trace?: RuntimeTracePort;
  clock?: AAOClock;
  /** Trusted per-node Runtime reliability policy (for example `{ search: { maxAttempts: 2 } }`). Default: one attempt everywhere. */
  reliability?: Readonly<Record<string, ReliabilityPolicy>>;
}

export type CompanyResearchRunOutcome =
  | { status: "completed"; result: CompanyResearchResult; execution: WorkflowExecutionResult }
  | { status: "failed"; failure: Pick<RuntimeFailure, "code" | "nodeId" | "executorFailure">; execution: WorkflowExecutionResult };

export interface ProofRegistrationSnapshot {
  readonly workflow: {
    readonly id: string;
    readonly version: string;
    readonly planFingerprint: string;
  };
  readonly tools: ReadonlyArray<{
    readonly id: string;
    readonly version: string;
  }>;
  readonly modelPolicies: ReadonlyArray<string>;
  readonly modelBindings: ReadonlyArray<{
    readonly id: string;
    readonly capabilities: ReadonlyArray<string>;
    readonly adapterRef: {
      readonly id: string;
      readonly version: string;
    };
  }>;
  readonly modelAdapters: ReadonlyArray<{
    readonly id: string;
    readonly version: string;
    readonly capabilities: ReadonlyArray<{
      readonly capability: string;
      readonly support: "supported" | "unsupported";
    }>;
  }>;
}

export interface CompanyResearchProof {
  readonly workflow: Workflow;
  readonly planFingerprint: string;
  readonly registrationSnapshot: ProofRegistrationSnapshot;
  run(input: { runId: string; request: CompanyResearchRequestInput }): Promise<CompanyResearchRunOutcome>;
}

/**
 * Composes the Company Research proof from public AAO surfaces only:
 * `createAAO` (@aao/framework) with the public-web Tools
 * (@aao/integration-public-web), the exact Toolbox Tools
 * `records.dedupe` and `records.project` (@aao/toolbox), the proof's
 * deterministic executors and Model Policies, and the host's model
 * adapters, bindings, provider, Governance, and identity.
 *
 * Every Tool call goes through the canonical Tool Runtime (support gate,
 * Authorization, schemas, Trace, reliability). Both model calls go through
 * the canonical Model Runtime. There is no Agent, no model Tool use, no
 * memory, no Artifact store, no Approval, and no side effect.
 */
export function createCompanyResearchProof(options: CompanyResearchProofOptions): CompanyResearchProof {
  const web = createPublicWebTools({ provider: options.researchProvider });
  const tools = options.tools
    ? [...options.tools]
    : [web.search, web.fetchPages, ...selectToolboxTools(coreToolbox, [DEDUPE_TOOL_REF, PROJECT_TOOL_REF])];
  const modelPolicies = options.modelPolicies
    ? [...options.modelPolicies]
    : [...COMPANY_RESEARCH_MODEL_POLICIES];
  const modelAdapters = [...options.modelAdapters];
  const modelBindings = [...options.modelBindings];

  const app = createAAO({
    governance: options.governance,
    principalForRun: options.principalForRun,
    tools,
    modelAdapters,
    modelBindings,
    modelPolicies,
    deterministicExecutors: COMPANY_RESEARCH_EXECUTORS,
    ...(options.trace !== undefined ? { trace: options.trace } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });
  const prepared = app.prepareWorkflow(companyResearchWorkflow, options.reliability ? { reliability: { policiesByNodeId: options.reliability } } : undefined);

  const registrationSnapshot: ProofRegistrationSnapshot = Object.freeze({
    workflow: Object.freeze({
      id: prepared.workflow.id,
      version: prepared.workflow.version,
      planFingerprint: prepared.planFingerprint,
    }),
    tools: Object.freeze(
      tools.map((t) => Object.freeze({ id: t.spec.id, version: t.spec.version }))
    ),
    modelPolicies: Object.freeze(modelPolicies.map((p) => p.id)),
    modelBindings: Object.freeze(
      modelBindings.map((b) =>
        Object.freeze({
          id: b.id,
          capabilities: Object.freeze([...b.capabilities]),
          adapterRef: Object.freeze({ id: b.adapterRef.id, version: b.adapterRef.version }),
        })
      )
    ),
    modelAdapters: Object.freeze(
      modelAdapters.map((a) =>
        Object.freeze({
          id: a.manifest.id,
          version: a.manifest.version,
          capabilities: Object.freeze(
            a.manifest.capabilities.map((c) =>
              Object.freeze({ capability: c.capability, support: c.support })
            )
          ),
        })
      )
    ),
  });

  async function run(input: { runId: string; request: CompanyResearchRequestInput }): Promise<CompanyResearchRunOutcome> {
    const runId = input.runId;
    const execution = await prepared.execute({ runId, initialState: { runId, revision: 0, values: { [STATE_KEYS.request]: input.request as unknown as JsonValue } } });
    if (!execution.ok) {
      const { code, nodeId, executorFailure } = execution.failure;
      return { status: "failed", failure: { code, ...(nodeId !== undefined ? { nodeId } : {}), ...(executorFailure !== undefined ? { executorFailure } : {}) }, execution };
    }
    return { status: "completed", result: execution.execution.state.values[STATE_KEYS.researchResult] as unknown as CompanyResearchResult, execution };
  }

  return Object.freeze({ workflow: prepared.workflow, planFingerprint: prepared.planFingerprint, registrationSnapshot, run });
}
