import { createInMemoryTraceStore, createTraceRecorder, validateTrace } from "@aao/observability";
import type { TraceEvent } from "@aao/contracts";
import { createFixtureProof, fixedClock, ACME_REQUEST, type FixtureProviderOptions, type ScriptedOutputs } from "../fixtures/index.js";
import type { CompanyResearchProofOptions, CompanyResearchRequestInput } from "../src/index.js";
import type { Principal } from "@aao/framework";

export type { TraceEvent };

/** Runs the fixture proof once with a Trace recorder and returns everything a test inspects. */
export async function runProof(options: { outputs?: ScriptedOutputs; provider?: FixtureProviderOptions; principal?: Principal; request?: CompanyResearchRequestInput; runId?: string; reliability?: CompanyResearchProofOptions["reliability"] } = {}) {
  const store = createInMemoryTraceStore();
  const trace = createTraceRecorder({ store, clock: fixedClock() });
  const { proof, provider, model } = createFixtureProof({ ...options, trace });
  const runId = options.runId ?? "run.research";
  const outcome = await proof.run({ runId, request: options.request ?? ACME_REQUEST });
  const events = (await store.getRunTrace(runId)) as TraceEvent[];
  return { proof, provider, model, outcome, trace: events, traceValid: validateTrace(events).valid, runId };
}

export const values = (outcome: Awaited<ReturnType<typeof runProof>>["outcome"]) => outcome.execution.execution?.state.values ?? {};
export const ofType = (trace: readonly TraceEvent[], type: string) => trace.filter((event) => event.type === type);
/** Tool ids whose handler started, in order. */
export const toolsStarted = (trace: readonly TraceEvent[]) => ofType(trace, "tool.call.started").map((event) => (event.payload as { toolRef: { id: string } }).toolRef.id);
/** Node ids that completed, in order. */
export const nodesCompleted = (trace: readonly TraceEvent[]) => ofType(trace, "node.completed").map((event) => event.nodeId!);
