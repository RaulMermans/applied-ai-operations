import type { AAOClock, RuntimeTracePort } from "@aao/framework";
import {
  createOperationalRequestProof,
  type OperationalDraftRepository,
  type OperationalRequestProof,
} from "../src/index.js";
import { fixtureGovernance, operator } from "./governance.js";
import {
  fixtureBinding,
  nativeModelAdapter,
  scriptedOperationalModel,
  vercelModelAdapter,
  type ScriptedModelOptions,
} from "./models.js";

export * from "./requests.js";
export * from "./governance.js";
export * from "./models.js";

export function fixedClock(time = "2026-10-18T10:00:00.000Z"): AAOClock {
  return { now: () => time };
}

export function createFixtureProof(
  options: {
    modelOptions?: ScriptedModelOptions;
    draftRepository?: OperationalDraftRepository;
    trace?: RuntimeTracePort;
    clock?: AAOClock;
    useVercelAdapter?: boolean;
  } = {}
): {
  proof: OperationalRequestProof;
  providerCalls: () => number;
} {
  let calls = 0;
  let modelAdapterDef;

  if (options.useVercelAdapter) {
    const vercel = vercelModelAdapter(options.modelOptions);
    modelAdapterDef = vercel.definition;
    calls = 0;
    return {
      proof: createOperationalRequestProof({
        modelAdapters: [modelAdapterDef],
        modelBindings: [fixtureBinding(modelAdapterDef.manifest)],
        governance: fixtureGovernance,
        principalForRun: () => operator,
        draftRepository: options.draftRepository,
        trace: options.trace,
        clock: options.clock ?? fixedClock(),
      }),
      providerCalls: vercel.providerCalls,
    };
  }

  const native = nativeModelAdapter(scriptedOperationalModel(options.modelOptions));
  return {
    proof: createOperationalRequestProof({
      modelAdapters: [native],
      modelBindings: [fixtureBinding(native.manifest)],
      governance: fixtureGovernance,
      principalForRun: () => operator,
      draftRepository: options.draftRepository,
      trace: options.trace,
      clock: options.clock ?? fixedClock(),
    }),
    providerCalls: () => calls,
  };
}
