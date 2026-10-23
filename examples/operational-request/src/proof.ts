import {
  createAAO,
  defineModelPolicy,
  type AAOApp,
  type AAOApprovals,
  type AAOClock,
  type GovernanceConfiguration,
  type JsonValue,
  type ModelAdapterDefinition,
  type ModelBindingDefinition,
  type ModelPolicySpec,
  type PrincipalForRun,
  type ReliabilityPolicy,
  type RuntimeExecutionState,
  type RuntimeTracePort,
  type ToolDefinition,
  type Workflow,
  type WorkflowExecutionResult,
} from "@aao/framework";
import { deriveToolExecutionId } from "@aao/tool-runtime";
import { OPERATIONAL_REQUEST_EXECUTORS, STATE_KEYS } from "./executors.js";
import { INTERPRET_POLICY_REF } from "./model-requests.js";
import { createInMemoryDraftRepository, type OperationalDraftRepository } from "./repository.js";
import {
  createOperationalApprovalVerifier,
  createOperationalDraftTool,
  type OperationalApprovalVerifier,
} from "./tool.js";
import { operationalRequestWorkflow } from "./workflow.js";
import type { OperationalRequestInput } from "./contracts.js";

export const OPERATIONAL_REQUEST_MODEL_POLICIES: readonly ModelPolicySpec[] = Object.freeze([
  defineModelPolicy({
    schemaVersion: 1,
    id: INTERPRET_POLICY_REF,
    version: "1.0.0",
    name: "Operational request structured interpretation",
    requiredCapabilities: ["model.structured_output"],
  }),
]);

export interface OperationalRequestProofOptions {
  modelAdapters: readonly ModelAdapterDefinition[];
  modelBindings: readonly ModelBindingDefinition[];
  governance: GovernanceConfiguration;
  principalForRun: PrincipalForRun;
  draftRepository?: OperationalDraftRepository;
  tools?: readonly ToolDefinition[];
  modelPolicies?: readonly ModelPolicySpec[];
  trace?: RuntimeTracePort;
  clock?: AAOClock;
  reliability?: Readonly<Record<string, ReliabilityPolicy>>;
}

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

export interface OperationalRequestProof {
  readonly workflow: Workflow;
  readonly planFingerprint: string;
  readonly registrationSnapshot: ProofRegistrationSnapshot;
  readonly app: AAOApp;
  readonly draftRepository: OperationalDraftRepository;
  readonly approvals: AAOApprovals;
  readonly approvalVerifier: OperationalApprovalVerifier;
  execute(input: { runId: string; request: OperationalRequestInput }): Promise<WorkflowExecutionResult>;
  continue(execution: RuntimeExecutionState): Promise<WorkflowExecutionResult>;
}

/**
 * Composes the Operational Request proof from public AAO Framework surfaces:
 * `createAAO` (@aao/framework) with governed draft creation Tool, deterministic
 * executors, canonical Model Policy, and host-supplied bindings, Governance, and identity.
 *
 * Deterministic software owns intake, proposal validation, approval subject binding,
 * and result rendering. The single model call is strictly bounded to structured interpretation.
 * Draft execution goes through the canonical Tool Runtime only after human approval.
 */
export function createOperationalRequestProof(
  options: OperationalRequestProofOptions
): OperationalRequestProof {
  const draftRepository = options.draftRepository ?? createInMemoryDraftRepository();
  const approvalsHolder: { current?: AAOApprovals } = {};
  const approvalVerifier = createOperationalApprovalVerifier({
    getApproval: (id) => approvalsHolder.current?.get(id),
  });
  const draftTool = createOperationalDraftTool({
    repository: draftRepository,
    approvalVerifier,
  });
  const tools = options.tools ? [...options.tools] : [draftTool];
  const modelPolicies = options.modelPolicies
    ? [...options.modelPolicies]
    : [...OPERATIONAL_REQUEST_MODEL_POLICIES];
  const modelAdapters = [...options.modelAdapters];
  const modelBindings = [...options.modelBindings];

  const app = createAAO({
    governance: options.governance,
    principalForRun: options.principalForRun,
    tools,
    modelAdapters,
    modelBindings,
    modelPolicies,
    deterministicExecutors: OPERATIONAL_REQUEST_EXECUTORS,
    ...(options.trace !== undefined ? { trace: options.trace } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });

  approvalsHolder.current = app.approvals;

  const prepared = app.prepareWorkflow(
    operationalRequestWorkflow,
    options.reliability ? { reliability: { policiesByNodeId: options.reliability } } : undefined
  );

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

  return Object.freeze({
    workflow: prepared.workflow,
    planFingerprint: prepared.planFingerprint,
    registrationSnapshot,
    app,
    draftRepository,
    approvals: app.approvals,
    approvalVerifier,
    execute: async (input: { runId: string; request: OperationalRequestInput }) => {
      return prepared.execute({
        runId: input.runId,
        initialState: {
          runId: input.runId,
          revision: 0,
          values: {
            [STATE_KEYS.request]: input.request as unknown as JsonValue,
          },
        },
      });
    },
    continue: async (execution: RuntimeExecutionState) => {
      const runId = execution.run.runId;
      const expectedToolExecutionId = deriveToolExecutionId(runId, "create_draft");
      approvalVerifier.attestExecutionOrigin?.(runId, expectedToolExecutionId);
      return prepared.continue(execution);
    },
  });
}
