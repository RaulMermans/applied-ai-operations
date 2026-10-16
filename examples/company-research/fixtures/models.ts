import { defineGovernance, defineModelAdapter, type ModelAdapter, type ModelAdapterDefinition, type ModelAdapterRequest, type ModelAdapterResult, type ModelBindingDefinition, type Principal } from "@aao/framework";
import { publicWebSourceId } from "@aao/integration-public-web";
import { createVercelAiModelAdapter, VERCEL_AI_SDK_ADAPTER_MANIFEST } from "@aao/model-runtime/vercel-ai";
import { MockLanguageModelV3 } from "ai/test";
import type { CompanyResearchRequestInput } from "../src/index.js";
import { PAGES } from "./corpus.js";

// Deterministic model fixtures: a native scripted adapter and the
// production Vercel AI SDK adapter over the SDK's own mock language model.
// No provider, no credentials, no network. Both answer by the structured
// output name the Workflow requests, so one adapter serves both calls.

export const researcher: Principal = { id: "user.researcher", type: "user" }; // read_only
export const drafter: Principal = { id: "user.drafter", type: "user" }; // write_draft only: lacks read_only

export const fixtureGovernance = defineGovernance({
  actors: [researcher, drafter],
  roles: [
    { id: "researcher", version: "1.0.0", permissionClasses: ["read_only"] },
    { id: "drafter", version: "1.0.0", permissionClasses: ["write_draft"] },
  ],
  bindings: [
    { id: "researcher.researcher", actorId: researcher.id, roleId: "researcher", status: "active" },
    { id: "drafter.drafter", actorId: drafter.id, roleId: "drafter", status: "active" },
  ],
  policies: [],
});

export const ACME_REQUEST: CompanyResearchRequestInput = {
  company: { name: "Acme Analytics", domain: "acme.example" },
  questions: [
    { id: "offering", question: "What does Acme Analytics sell?" },
    { id: "customers", question: "Who appears to be its target customer?" },
    { id: "differentiation", question: "What differentiates its product?" },
  ],
};

export const ACME_PLAN = {
  queries: [
    { id: "products", query: "Acme Analytics products", questionIds: ["offering"] },
    { id: "customers", query: "Acme Analytics target customers", questionIds: ["customers"] },
    { id: "differentiation", query: "Acme Analytics differentiation", questionIds: ["differentiation"] },
  ],
};

export const SOURCE_IDS = Object.freeze({
  home: publicWebSourceId(PAGES.home.url),
  customers: publicWebSourceId(PAGES.customers.url),
  launch: publicWebSourceId(PAGES.launch.url),
  review: publicWebSourceId(PAGES.review.url),
});

export const ACME_DRAFT = {
  answers: [
    {
      questionId: "offering",
      status: "answered",
      findings: [
        { statement: "Acme Analytics sells Acme Insight, a subscription product analytics platform billed monthly per storefront.", sourceRefs: [SOURCE_IDS.home] },
        { statement: "Acme Insight reports conversion funnels, retention cohorts, and basket analysis.", sourceRefs: [SOURCE_IDS.home] },
      ],
    },
    { questionId: "customers", status: "answered", findings: [{ statement: "Its customers appear to be mid-size online retailers with 50 to 500 employees in Europe and North America.", sourceRefs: [SOURCE_IDS.customers] }] },
    { questionId: "differentiation", status: "answered", findings: [{ statement: "It anonymizes shopper events on the device and uses no third-party cookies, which the company presents as its differentiator.", sourceRefs: [SOURCE_IDS.launch] }] },
  ],
  overallLimitations: ["Pricing levels were not found in the retrieved sources."],
};

/** A draft that answers nothing: the correct synthesis when no evidence exists. */
export const insufficientDraft = (questionIds: readonly string[] = ["offering", "customers", "differentiation"]) => ({
  answers: questionIds.map((questionId) => ({ questionId, status: "insufficient_evidence", findings: [], limitation: "No retrieved source addresses this question." })),
  overallLimitations: [],
});

export interface ScriptedOutputs {
  /** The planning model's structured output, or a function of the request. */
  plan?: unknown;
  /** The synthesis model's structured output, or a function of the request. */
  draft?: unknown;
}

const pick = (value: unknown, request: ModelAdapterRequest) => (typeof value === "function" ? (value as (r: ModelAdapterRequest) => unknown)(request) : value);
const USAGE = { inputTokens: 120, outputTokens: 40, totalTokens: 160 };

/** A scripted native model adapter that records every request it receives. */
export function scriptedResearchModel(outputs: ScriptedOutputs = {}): ModelAdapter & { requests: ModelAdapterRequest[] } {
  const requests: ModelAdapterRequest[] = [];
  return {
    requests,
    async invoke(request): Promise<ModelAdapterResult> {
      requests.push(JSON.parse(JSON.stringify(request)) as ModelAdapterRequest);
      const name = request.output.kind === "structured" ? request.output.name : undefined;
      if (name === "research_plan") return { status: "succeeded", output: pick(outputs.plan ?? ACME_PLAN, request), finishReason: "stop", usage: USAGE };
      if (name === "company_research_draft") return { status: "succeeded", output: pick(outputs.draft ?? ACME_DRAFT, request), finishReason: "stop", usage: USAGE };
      return { status: "failed", reason: "unsupported_response" };
    },
  };
}

export const NATIVE_ADAPTER_REF = Object.freeze({ id: "fixture.research-model", version: "1.0.0" });
export const VERCEL_ADAPTER_REF = Object.freeze({ id: VERCEL_AI_SDK_ADAPTER_MANIFEST.id, version: VERCEL_AI_SDK_ADAPTER_MANIFEST.version });

export function nativeModelAdapter(adapter: ModelAdapter = scriptedResearchModel()): ModelAdapterDefinition {
  return defineModelAdapter({
    manifest: {
      id: NATIVE_ADAPTER_REF.id,
      version: NATIVE_ADAPTER_REF.version,
      kind: "model",
      capabilities: [
        { capability: "model.text_generation", support: "supported" },
        { capability: "model.structured_output", support: "supported" },
        { capability: "model.usage", support: "supported" },
        { capability: "model.cancellation", support: "unsupported" },
        { capability: "model.tool_call_response", support: "unsupported" },
      ],
    },
    adapter,
  });
}

/**
 * The production Vercel AI SDK adapter driven by the SDK's deterministic
 * MockLanguageModelV3. The mock answers by the response-format name the
 * adapter forwards. It records how many provider calls it received.
 */
export function vercelModelAdapter(outputs: ScriptedOutputs = {}): { definition: ModelAdapterDefinition; providerCalls: () => number } {
  let providerCalls = 0;
  const model = new MockLanguageModelV3({
    doGenerate: (async (options: { responseFormat?: { type: string; name?: string } }) => {
      providerCalls += 1;
      const name = options.responseFormat?.name;
      const output = name === "research_plan" ? (outputs.plan ?? ACME_PLAN) : name === "company_research_draft" ? (outputs.draft ?? ACME_DRAFT) : undefined;
      if (output === undefined || typeof output === "function") throw new Error("unscripted request");
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 120, noCache: 120, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 40, text: 40, reasoning: 0 } },
        warnings: [],
      };
    }) as never,
  });
  return { definition: defineModelAdapter({ manifest: VERCEL_AI_SDK_ADAPTER_MANIFEST, adapter: createVercelAiModelAdapter({ model }) }), providerCalls: () => providerCalls };
}

/** One host binding for both Model Policies. Only `adapterRef` and the trusted identity differ between substrates. */
export function fixtureBinding(adapterRef: { id: string; version: string } = NATIVE_ADAPTER_REF): ModelBindingDefinition {
  return {
    id: "research-model",
    priority: 10,
    capabilities: ["model.text_generation", "model.structured_output"],
    identity: adapterRef.id === NATIVE_ADAPTER_REF.id ? { provider: "fixture", model: "scripted-research" } : { provider: "fixture-vercel", model: "mock-language-model" },
    adapterRef: { ...adapterRef },
  };
}
