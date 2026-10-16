import type { Principal, RuntimeTracePort } from "@aao/framework";
import {
  createDocumentIntelligenceProof,
  type DocumentIntelligenceProofOptions,
} from "../src/index.js";
import {
  createDocumentFixtureProvider,
  type DocumentFixtureProviderOptions,
  type FixtureDocumentProvider,
} from "./provider.js";
import {
  fixtureBinding,
  fixtureGovernance,
  nativeModelAdapter,
  reader,
  scriptedDocumentModel,
  type ScriptedDocumentModel,
  type ScriptedModelOptions,
} from "./models.js";

export {
  ACME_CONTRACT_PAGES,
  ACME_CONTRACT_PDF_BYTES,
  ACME_DOCUMENT_REF,
  ACME_PLAIN_TEXT_BYTES,
  ACME_PLAIN_TEXT_CONTENT,
  ACME_TEXT_DOCUMENT_REF,
  INJECTION_TEXT,
  SAMPLE_QUESTIONS,
  SECRET_TOKEN,
  buildSimplePdf,
} from "./corpus.js";

export {
  createDocumentFixtureProvider,
  type DocumentFixtureProviderOptions,
  type FixtureDocumentProvider,
} from "./provider.js";

export {
  NATIVE_DOC_ADAPTER_REF,
  VERCEL_DOC_ADAPTER_REF,
  fixtureBinding,
  fixtureGovernance,
  nativeModelAdapter,
  reader,
  scriptedDocumentModel,
  synthesizeDraftFromPrompt,
  unauthorizedUser,
  vercelModelAdapter,
  type ScriptedDocumentModel,
  type ScriptedModelOptions,
} from "./models.js";

/** A fixed clock: deterministic timestamps, no wall clock. */
export function fixedClock() {
  let tick = 0;
  return { now: () => new Date(Date.UTC(2026, 9, 16, 12, 0, tick++)).toISOString() };
}

export interface FixtureProofResult {
  readonly proof: ReturnType<typeof createDocumentIntelligenceProof>;
  readonly provider: FixtureDocumentProvider;
  readonly model: ScriptedDocumentModel;
}

/** A fully deterministic proof over the native scripted model and fixture provider. */
export function createFixtureProof(
  options: {
    modelOptions?: ScriptedModelOptions;
    providerOptions?: DocumentFixtureProviderOptions;
    principal?: Principal;
    trace?: RuntimeTracePort;
    reliability?: DocumentIntelligenceProofOptions["reliability"];
  } = {}
): FixtureProofResult {
  const provider = createDocumentFixtureProvider(options.providerOptions);
  const model = scriptedDocumentModel(options.modelOptions);
  const proof = createDocumentIntelligenceProof({
    modelAdapters: [nativeModelAdapter(model)],
    modelBindings: [fixtureBinding()],
    documentSourceProvider: provider,
    governance: fixtureGovernance,
    principalForRun: () => options.principal ?? reader,
    clock: fixedClock(),
    ...(options.trace ? { trace: options.trace } : {}),
    ...(options.reliability ? { reliability: options.reliability } : {}),
  });

  return { proof, provider, model };
}
