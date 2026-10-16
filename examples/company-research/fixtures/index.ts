// Test support for the Company Research proof: deterministic fixtures for
// tests, Eval evidence, the compiled smoke, and the proof command. Never
// imported by `src/`: the proof's runtime API ships no fixture.
import type { Principal, RuntimeTracePort } from "@aao/framework";
import { createCompanyResearchProof, type CompanyResearchProofOptions } from "../src/index.js";
import { createFixtureProvider, type FixtureProvider, type FixtureProviderOptions } from "./provider.js";
import { fixtureBinding, fixtureGovernance, nativeModelAdapter, researcher, scriptedResearchModel, type ScriptedOutputs } from "./models.js";

export { INJECTION_TEXT, PAGES, SECRET } from "./corpus.js";
export { createFixtureProvider, type FixtureProvider, type FixtureProviderOptions } from "./provider.js";
export {
  ACME_DRAFT,
  ACME_PLAN,
  ACME_REQUEST,
  NATIVE_ADAPTER_REF,
  SOURCE_IDS,
  VERCEL_ADAPTER_REF,
  drafter,
  fixtureBinding,
  fixtureGovernance,
  insufficientDraft,
  nativeModelAdapter,
  researcher,
  scriptedResearchModel,
  vercelModelAdapter,
  type ScriptedOutputs,
} from "./models.js";

/** A fixed clock: deterministic timestamps, no wall clock. */
export function fixedClock() {
  let tick = 0;
  return { now: () => new Date(Date.UTC(2026, 9, 15, 12, 0, tick++)).toISOString() };
}

/** A fully deterministic proof over the native scripted model and a fixture provider. */
export function createFixtureProof(options: { outputs?: ScriptedOutputs; provider?: FixtureProviderOptions; principal?: Principal; trace?: RuntimeTracePort; reliability?: CompanyResearchProofOptions["reliability"] } = {}) {
  const provider: FixtureProvider = createFixtureProvider(options.provider);
  const model = scriptedResearchModel(options.outputs);
  const proof = createCompanyResearchProof({
    modelAdapters: [nativeModelAdapter(model)],
    modelBindings: [fixtureBinding()],
    researchProvider: provider,
    governance: fixtureGovernance,
    principalForRun: () => options.principal ?? researcher,
    clock: fixedClock(),
    ...(options.trace ? { trace: options.trace } : {}),
    ...(options.reliability ? { reliability: options.reliability } : {}),
  });
  return { proof, provider, model };
}
