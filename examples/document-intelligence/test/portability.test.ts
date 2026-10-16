import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { vi, describe, expect, it } from "vitest";
import { createInMemoryTraceStore, createTraceRecorder } from "@aao/observability";
import type { TraceEvent } from "@aao/contracts";
import {
  ACME_DOCUMENT_REF,
  NATIVE_DOC_ADAPTER_REF,
  SAMPLE_QUESTIONS,
  VERCEL_DOC_ADAPTER_REF,
  createDocumentFixtureProvider,
  fixedClock,
  fixtureBinding,
  fixtureGovernance,
  nativeModelAdapter,
  reader,
  scriptedDocumentModel,
  vercelModelAdapter,
  type DocumentFixtureProviderOptions,
} from "../fixtures/index.js";
import {
  createDocumentIntelligenceProof,
  documentIntelligenceWorkflow,
  type DocumentIntelligenceResult,
} from "../src/index.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

async function runWith(
  substrate: "native" | "vercel",
  providerVariant: DocumentFixtureProviderOptions["variant"] = "a"
) {
  const store = createInMemoryTraceStore();
  const vercel = vercelModelAdapter();
  const native = scriptedDocumentModel();
  const provider = createDocumentFixtureProvider({ variant: providerVariant });

  const proof = createDocumentIntelligenceProof({
    modelAdapters: [substrate === "native" ? nativeModelAdapter(native) : vercel.definition],
    modelBindings: [
      fixtureBinding(substrate === "native" ? NATIVE_DOC_ADAPTER_REF : VERCEL_DOC_ADAPTER_REF),
    ],
    documentSourceProvider: provider,
    governance: fixtureGovernance,
    principalForRun: () => reader,
    trace: createTraceRecorder({ store, clock: fixedClock() }),
    clock: fixedClock(),
  });

  const outcome = await proof.run({
    runId: "run.portable",
    request: {
      documentRef: ACME_DOCUMENT_REF,
      questions: SAMPLE_QUESTIONS,
    },
  });

  const trace = (await store.getRunTrace("run.portable")) as TraceEvent[];
  if (outcome.status !== "completed") {
    throw new Error(`${substrate}/${providerVariant} failed: ${JSON.stringify(outcome.failure)}`);
  }

  return {
    proof,
    result: outcome.result as DocumentIntelligenceResult,
    nodes: trace.filter((e) => e.type === "node.completed").map((e) => e.nodeId),
    tools: trace
      .filter((e) => e.type === "tool.call.started")
      .map((e) => (e.payload.toolRef as { id: string }).id),
    models: trace
      .filter((e) => e.type === "model.call.started")
      .map((e) => e.payload.modelIdentity),
    providerCalls: {
      provider: provider.calls.length,
      model: substrate === "native" ? native.requests.length : vercel.providerCalls(),
    },
  };
}

describe("model portability: same Workflow, different model substrate", () => {
  it("native scripted reference and Vercel AI SDK adapter reach identical semantic results", async () => {
    const before = JSON.stringify(documentIntelligenceWorkflow);
    const [native, vercel] = [await runWith("native"), await runWith("vercel")];

    expect(JSON.stringify(documentIntelligenceWorkflow)).toBe(before);
    expect(vercel.proof.workflow).toEqual(native.proof.workflow);
    expect(vercel.proof.planFingerprint).toBe(native.proof.planFingerprint);
    expect(vercel.nodes).toEqual(native.nodes);
    expect(vercel.tools).toEqual(native.tools);
    expect(vercel.providerCalls).toEqual(native.providerCalls);
    expect(native.providerCalls.model).toBe(1);
    expect(vercel.result).toEqual(native.result);

    // Only the trusted registration identity differs
    expect(native.models).toEqual([{ provider: "fixture", model: "scripted-doc-intel" }]);
    expect(vercel.models).toEqual([{ provider: "fixture-vercel", model: "mock-language-model" }]);
  });
});

describe("provider portability: same Workflow, equivalent provider implementations", () => {
  it("fixture providers A and B yield the same document identity, spans, and result", async () => {
    const [a, b] = [await runWith("native", "a"), await runWith("native", "b")];
    expect(b.nodes).toEqual(a.nodes);
    expect(b.tools).toEqual(a.tools);
    expect(b.providerCalls).toEqual(a.providerCalls);
    expect(b.result.document.documentId).toBe(a.result.document.documentId);
    expect(b.result.document.documentFingerprint).toBe(a.result.document.documentFingerprint);
    expect(b.result.evidenceIndex).toEqual(a.result.evidenceIndex);
    expect(b.result.answers).toEqual(a.result.answers);
  });
});

describe("no provider or vendor names in Workflow semantics (static check)", () => {
  it("the Workflow spec and its source name no document service or model vendor", () => {
    const source =
      readFileSync(new URL("../src/workflow.ts", import.meta.url), "utf8") +
      readFileSync(new URL("../src/model-requests.ts", import.meta.url), "utf8") +
      JSON.stringify(documentIntelligenceWorkflow);

    for (const name of [
      "Adobe",
      "PDFjs",
      "unpdf",
      "Textract",
      "AWS",
      "S3",
      "SharePoint",
      "Google",
      "OpenAI",
      "Anthropic",
      "Claude",
      "GPT",
    ]) {
      expect(source, name).not.toMatch(new RegExp(`\\b${name}\\b`, "i"));
    }
  });
});
