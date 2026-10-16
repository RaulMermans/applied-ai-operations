import {
  createAAO,
  defineModelPolicy,
  type AAOClock,
  type GovernanceConfiguration,
  type JsonValue,
  type ModelAdapterDefinition,
  type ModelBindingDefinition,
  type ModelPolicySpec,
  type PrincipalForRun,
  type ReliabilityPolicy,
  type RuntimeFailure,
  type RuntimeTracePort,
  type Workflow,
  type WorkflowExecutionResult,
} from "@aao/framework";
import {
  createDocumentTools,
  type DocumentSourceProvider,
} from "@aao/integration-documents";
import type {
  DocumentIntelligenceRequestInput,
  DocumentIntelligenceResult,
} from "./contracts.js";
import {
  DOCUMENT_INTELLIGENCE_EXECUTORS,
  STATE_KEYS,
} from "./executors.js";
import { SYNTHESIS_POLICY_REF } from "./model-requests.js";
import { documentIntelligenceWorkflow } from "./workflow.js";

/** The proof's canonical Model Policy for structured synthesis. Routing to a binding is the Model Runtime's. */
export const DOCUMENT_INTELLIGENCE_MODEL_POLICIES: readonly ModelPolicySpec[] = Object.freeze([
  defineModelPolicy({
    schemaVersion: 1,
    id: SYNTHESIS_POLICY_REF,
    version: "1.0.0",
    name: "Document intelligence structured synthesis",
    requiredCapabilities: ["model.structured_output"],
  }),
]);

export interface DocumentIntelligenceProofOptions {
  /** Model adapters (`defineModelAdapter`), supplied by the host. */
  modelAdapters: readonly ModelAdapterDefinition[];
  /** Host model bindings; needs `model.structured_output`. */
  modelBindings: readonly ModelBindingDefinition[];
  /** The host's document-source provider. The Workflow never names it. */
  documentSourceProvider: DocumentSourceProvider;
  /** Canonical Governance. The Run's principal needs `read_only`; nothing else is needed or used. */
  governance: GovernanceConfiguration;
  /** The host's identity boundary, exactly as for `createAAO`. */
  principalForRun: PrincipalForRun;
  trace?: RuntimeTracePort;
  clock?: AAOClock;
  /** Trusted per-node Runtime reliability policy. Default: one attempt everywhere. */
  reliability?: Readonly<Record<string, ReliabilityPolicy>>;
}

export type DocumentIntelligenceRunOutcome =
  | { status: "completed"; result: DocumentIntelligenceResult; execution: WorkflowExecutionResult }
  | { status: "failed"; failure: Pick<RuntimeFailure, "code" | "nodeId" | "executorFailure">; execution: WorkflowExecutionResult };

export interface DocumentIntelligenceProof {
  readonly workflow: Workflow;
  readonly planFingerprint: string;
  run(input: { runId: string; request: DocumentIntelligenceRequestInput }): Promise<DocumentIntelligenceRunOutcome>;
}

/**
 * Composes the Document Intelligence proof from public AAO surfaces only:
 * `createAAO` (@aao/framework) with document extraction Tools
 * (@aao/integration-documents), deterministic executors, canonical Model Policy,
 * and host-supplied bindings, document-source provider, Governance, and identity.
 *
 * Every Tool call goes through the canonical Tool Runtime (permission gate,
 * Authorization, schemas, Trace, reliability). The single model call goes through
 * the canonical Model Runtime with strict structured outputs. There is no Agent,
 * no autonomous tool use, no RAG framework, no vector database, no OCR, no memory,
 * no Approval, and no side effect.
 */
export function createDocumentIntelligenceProof(options: DocumentIntelligenceProofOptions): DocumentIntelligenceProof {
  const docTools = createDocumentTools({ provider: options.documentSourceProvider });
  const app = createAAO({
    governance: options.governance,
    principalForRun: options.principalForRun,
    tools: [docTools.extractText],
    modelAdapters: options.modelAdapters,
    modelBindings: options.modelBindings,
    modelPolicies: DOCUMENT_INTELLIGENCE_MODEL_POLICIES,
    deterministicExecutors: DOCUMENT_INTELLIGENCE_EXECUTORS,
    ...(options.trace !== undefined ? { trace: options.trace } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });

  const prepared = app.prepareWorkflow(
    documentIntelligenceWorkflow,
    options.reliability ? { reliability: { policiesByNodeId: options.reliability } } : undefined
  );

  async function run(input: {
    runId: string;
    request: DocumentIntelligenceRequestInput;
  }): Promise<DocumentIntelligenceRunOutcome> {
    const runId = input.runId;
    const execution = await prepared.execute({
      runId,
      initialState: {
        runId,
        revision: 0,
        values: {
          [STATE_KEYS.request]: input.request as unknown as JsonValue,
        },
      },
    });

    if (!execution.ok) {
      const { code, nodeId, executorFailure } = execution.failure;
      return {
        status: "failed",
        failure: {
          code,
          ...(nodeId !== undefined ? { nodeId } : {}),
          ...(executorFailure !== undefined ? { executorFailure } : {}),
        },
        execution,
      };
    }

    return {
      status: "completed",
      result: execution.execution.state.values[STATE_KEYS.docResult] as unknown as DocumentIntelligenceResult,
      execution,
    };
  }

  return Object.freeze({
    workflow: prepared.workflow,
    planFingerprint: prepared.planFingerprint,
    run,
  });
}
