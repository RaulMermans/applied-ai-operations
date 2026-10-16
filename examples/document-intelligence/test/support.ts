import type { Principal } from "@aao/framework";
import type { TraceEvent } from "@aao/contracts";
import { createInMemoryTraceStore, createTraceRecorder, validateTrace } from "@aao/observability";
import {
  ACME_DOCUMENT_REF,
  SAMPLE_QUESTIONS,
  createFixtureProof,
  fixedClock,
  type DocumentFixtureProviderOptions,
  type ScriptedModelOptions,
} from "../fixtures/index.js";
import type {
  DocumentIntelligenceProofOptions,
  DocumentIntelligenceRequestInput,
} from "../src/index.js";

export type { TraceEvent };

export const DEFAULT_REQUEST: DocumentIntelligenceRequestInput = {
  documentRef: ACME_DOCUMENT_REF,
  questions: SAMPLE_QUESTIONS,
};

/** Runs the fixture proof once with a Trace recorder and returns everything a test inspects. */
export async function runProof(
  options: {
    modelOptions?: ScriptedModelOptions;
    providerOptions?: DocumentFixtureProviderOptions;
    principal?: Principal;
    request?: DocumentIntelligenceRequestInput;
    runId?: string;
    reliability?: DocumentIntelligenceProofOptions["reliability"];
  } = {}
) {
  const store = createInMemoryTraceStore();
  const trace = createTraceRecorder({ store, clock: fixedClock() });
  const { proof, provider, model } = createFixtureProof({ ...options, trace });
  const runId = options.runId ?? "run.doc-intel";
  const outcome = await proof.run({ runId, request: options.request ?? DEFAULT_REQUEST });
  const events = (await store.getRunTrace(runId)) as TraceEvent[];
  return {
    proof,
    provider,
    model,
    outcome,
    trace: events,
    traceValid: validateTrace(events).valid,
    runId,
  };
}

export const values = (outcome: Awaited<ReturnType<typeof runProof>>["outcome"]) =>
  outcome.execution.execution?.state.values ?? {};
export const ofType = (trace: readonly TraceEvent[], type: string) =>
  trace.filter((event) => event.type === type);
/** Tool ids whose handler started, in order. */
export const toolsStarted = (trace: readonly TraceEvent[]) =>
  ofType(trace, "tool.call.started").map((event) => (event.payload as { toolRef: { id: string } }).toolRef.id);
/** Node ids that completed, in order. */
export const nodesCompleted = (trace: readonly TraceEvent[]) =>
  ofType(trace, "node.completed").map((event) => event.nodeId!);
