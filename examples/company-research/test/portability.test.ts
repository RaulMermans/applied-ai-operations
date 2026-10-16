import { vi, describe, expect, it } from "vitest";
import { createInMemoryTraceStore, createTraceRecorder } from "@aao/observability";
import type { TraceEvent } from "@aao/contracts";
import { ACME_REQUEST, NATIVE_ADAPTER_REF, VERCEL_ADAPTER_REF, createFixtureProvider, fixedClock, fixtureBinding, fixtureGovernance, nativeModelAdapter, researcher, scriptedResearchModel, vercelModelAdapter, type FixtureProviderOptions } from "../fixtures/index.js";
import { companyResearchWorkflow, createCompanyResearchProof, type CompanyResearchResult } from "../src/index.js";

// Each test runs complete proof Workflows; keep them reliable on a loaded machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

/**
 * The same Workflow definition, unchanged, under alternate host bindings:
 * a native scripted model vs the production Vercel AI SDK adapter (over the
 * SDK's mock model), and fixture provider A vs an equivalent but noisier
 * fixture provider B. Only host configuration differs.
 */
async function runWith(substrate: "native" | "vercel", providerVariant: FixtureProviderOptions["variant"] = "a") {
  const store = createInMemoryTraceStore();
  const vercel = vercelModelAdapter();
  const native = scriptedResearchModel();
  const provider = createFixtureProvider({ variant: providerVariant });
  const proof = createCompanyResearchProof({
    modelAdapters: [substrate === "native" ? nativeModelAdapter(native) : vercel.definition],
    modelBindings: [fixtureBinding(substrate === "native" ? NATIVE_ADAPTER_REF : VERCEL_ADAPTER_REF)],
    researchProvider: provider,
    governance: fixtureGovernance,
    principalForRun: () => researcher,
    trace: createTraceRecorder({ store, clock: fixedClock() }),
    clock: fixedClock(),
  });
  const outcome = await proof.run({ runId: "run.portable", request: ACME_REQUEST });
  const trace = (await store.getRunTrace("run.portable")) as TraceEvent[];
  if (outcome.status !== "completed") throw new Error(`${substrate}/${providerVariant} failed: ${JSON.stringify(outcome.failure)}`);
  return {
    proof,
    result: outcome.result as CompanyResearchResult,
    nodes: trace.filter((event) => event.type === "node.completed").map((event) => event.nodeId),
    tools: trace.filter((event) => event.type === "tool.call.started").map((event) => (event.payload.toolRef as { id: string }).id),
    models: trace.filter((event) => event.type === "model.call.started").map((event) => event.payload.modelIdentity),
    providerCalls: { search: provider.calls.search.length, fetch: provider.calls.fetch.length, model: substrate === "native" ? native.requests.length : vercel.providerCalls() },
  };
}

describe("model portability: same Workflow, different model binding", () => {
  it("native scripted reference and the Vercel AI SDK adapter reach the same semantic result", async () => {
    const before = JSON.stringify(companyResearchWorkflow);
    const [native, vercel] = [await runWith("native"), await runWith("vercel")];
    expect(JSON.stringify(companyResearchWorkflow)).toBe(before);
    expect(vercel.proof.workflow).toEqual(native.proof.workflow);
    expect(vercel.proof.planFingerprint).toBe(native.proof.planFingerprint);
    expect(vercel.nodes).toEqual(native.nodes);
    expect(vercel.tools).toEqual(native.tools);
    expect(vercel.providerCalls).toEqual(native.providerCalls);
    expect(native.providerCalls.model).toBe(2);
    expect(vercel.result).toEqual(native.result);
    // Only the trusted registration identity differs.
    expect(native.models).toEqual([{ provider: "fixture", model: "scripted-research" }, { provider: "fixture", model: "scripted-research" }]);
    expect(vercel.models).toEqual([{ provider: "fixture-vercel", model: "mock-language-model" }, { provider: "fixture-vercel", model: "mock-language-model" }]);
  });
});

describe("provider portability: same Workflow, equivalent provider implementations", () => {
  it("fixture providers A and B yield the same source identities, citations, and result", async () => {
    const [a, b] = [await runWith("native", "a"), await runWith("native", "b")];
    expect(b.nodes).toEqual(a.nodes);
    expect(b.tools).toEqual(a.tools);
    expect(b.providerCalls).toEqual(a.providerCalls);
    expect(b.result.sourceIndex).toEqual(a.result.sourceIndex);
    expect(b.result.sourcesConsulted).toEqual(a.result.sourcesConsulted);
    expect(b.result).toEqual(a.result);
    expect(b.result.markdown).toBe(a.result.markdown);
  });
});

describe("no provider or vendor names in Workflow semantics (static)", () => {
  it("the Workflow spec and its source name no search provider or model vendor", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/workflow.ts", import.meta.url), "utf8") + readFileSync(new URL("../src/model-requests.ts", import.meta.url), "utf8") + JSON.stringify(companyResearchWorkflow);
    for (const name of ["Firecrawl", "Tavily", "SerpAPI", "Brave", "Google", "Bing", "Exa", "OpenAI", "Anthropic", "Vercel", "Claude", "GPT"]) expect(source, name).not.toMatch(new RegExp(`\\b${name}\\b`, "i"));
  });
});
