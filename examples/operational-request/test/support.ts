import {
  createInMemoryTraceStore,
  createTraceRecorder,
  type TraceStore,
} from "@aao/observability";
import type { WorkflowExecutionResult } from "@aao/framework";
import {
  createFixtureProof,
  fixedClock,
  manager,
  VALID_OPERATIONAL_REQUEST,
  type ScriptedModelOptions,
} from "../fixtures/index.js";
import type { OperationalRequestInput } from "../src/contracts.js";
import type { OperationalDraftRepository } from "../src/repository.js";

export interface ExecutedRunHelper {
  store: TraceStore;
  initial: WorkflowExecutionResult;
  resumed?: WorkflowExecutionResult;
  draftRepository: OperationalDraftRepository;
  approvalId?: string;
  requestFingerprint?: string;
}

export async function runApprovedWorkflow(options: {
  runId?: string;
  request?: OperationalRequestInput;
  modelOptions?: ScriptedModelOptions;
  useVercelAdapter?: boolean;
} = {}): Promise<ExecutedRunHelper> {
  const runId = options.runId ?? "run.test.approved";
  const request = options.request ?? VALID_OPERATIONAL_REQUEST;
  const store = createInMemoryTraceStore();
  const trace = createTraceRecorder({ store, clock: fixedClock() });

  const { proof } = createFixtureProof({
    modelOptions: options.modelOptions,
    trace,
    useVercelAdapter: options.useVercelAdapter,
  });

  const initial = await proof.execute({ runId, request });
  const approvalId = initial.execution?.wait?.referenceId;
  const requestFingerprint = initial.execution?.wait?.requestFingerprint;

  if (initial.execution?.run.status === "WAITING_FOR_APPROVAL" && approvalId) {
    proof.approvals.approve(approvalId, manager);
    const resumed = await proof.continue(initial.execution);
    return {
      store,
      initial,
      resumed,
      draftRepository: proof.draftRepository,
      approvalId,
      requestFingerprint,
    };
  }

  return {
    store,
    initial,
    draftRepository: proof.draftRepository,
    approvalId,
    requestFingerprint,
  };
}

export async function runRejectedWorkflow(options: {
  runId?: string;
  request?: OperationalRequestInput;
  modelOptions?: ScriptedModelOptions;
} = {}): Promise<ExecutedRunHelper> {
  const runId = options.runId ?? "run.test.rejected";
  const request = options.request ?? VALID_OPERATIONAL_REQUEST;
  const store = createInMemoryTraceStore();
  const trace = createTraceRecorder({ store, clock: fixedClock() });

  const { proof } = createFixtureProof({
    modelOptions: options.modelOptions,
    trace,
  });

  const initial = await proof.execute({ runId, request });
  const approvalId = initial.execution?.wait?.referenceId;
  const requestFingerprint = initial.execution?.wait?.requestFingerprint;

  if (initial.execution?.run.status === "WAITING_FOR_APPROVAL" && approvalId) {
    proof.approvals.reject(approvalId, manager);
    const resumed = await proof.continue(initial.execution);
    return {
      store,
      initial,
      resumed,
      draftRepository: proof.draftRepository,
      approvalId,
      requestFingerprint,
    };
  }

  return {
    store,
    initial,
    draftRepository: proof.draftRepository,
    approvalId,
    requestFingerprint,
  };
}

export function failureCode(result?: WorkflowExecutionResult): string | undefined {
  if (result && !result.ok) {
    return result.failure.code;
  }
  return undefined;
}

export function failureNodeId(result?: WorkflowExecutionResult): string | undefined {
  if (result && !result.ok) {
    return result.failure.nodeId;
  }
  return undefined;
}

