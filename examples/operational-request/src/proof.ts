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
import { OPERATIONAL_REQUEST_EXECUTORS, STATE_KEYS } from "./executors.js";
import { INTERPRET_POLICY_REF } from "./model-requests.js";
import { createInMemoryDraftRepository, type OperationalDraftRepository } from "./repository.js";
import { createOperationalApprovalVerifier, createOperationalDraftTool } from "./tool.js";
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
  trace?: RuntimeTracePort;
  clock?: AAOClock;
  reliability?: Readonly<Record<string, ReliabilityPolicy>>;
}

export interface OperationalRequestProof {
  readonly workflow: Workflow;
  readonly planFingerprint: string;
  readonly app: AAOApp;
  readonly draftRepository: OperationalDraftRepository;
  readonly approvals: AAOApprovals;
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
  const draftTool = createOperationalDraftTool({
    repository: draftRepository,
    approvalVerifier: createOperationalApprovalVerifier({
      getApproval: (id) => approvalsHolder.current?.get(id),
    }),
  });
  const tools = options.tools ? [...options.tools] : [draftTool];

  const app = createAAO({
    governance: options.governance,
    principalForRun: options.principalForRun,
    tools,
    modelAdapters: options.modelAdapters,
    modelBindings: options.modelBindings,
    modelPolicies: OPERATIONAL_REQUEST_MODEL_POLICIES,
    deterministicExecutors: OPERATIONAL_REQUEST_EXECUTORS,
    ...(options.trace !== undefined ? { trace: options.trace } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });

  approvalsHolder.current = app.approvals;

  const prepared = app.prepareWorkflow(
    operationalRequestWorkflow,
    options.reliability ? { reliability: { policiesByNodeId: options.reliability } } : undefined
  );

  return Object.freeze({
    workflow: prepared.workflow,
    planFingerprint: prepared.planFingerprint,
    app,
    draftRepository,
    approvals: app.approvals,
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
      return prepared.continue(execution);
    },
  });
}
