# Document Intelligence proof (`@aao/example-document-intelligence`)

An end-to-end AAO proof application for governed document ingestion, deterministic page/span provenance, and evidence-anchored extraction. Given an opaque document reference and up to 8 questions, it:

1. deterministically validates the request and prepares the governed extraction input;
2. extracts canonical page text using the `document.extract_text@1.0.0` Tool via the host's `DocumentSourceProvider`;
3. deterministically validates document pages, 1-based ordering, and document identity (`doc.<16-hex>`);
4. segments canonical page text into bounded evidence spans with exact UTF-16 code unit offsets;
5. admits spans within strict context character and count budgets;
6. synthesizes structured answers with a single bounded model call (`document_intelligence.synthesis`);
7. validates every citation reference against exact precomputed admitted evidence spans;
8. deterministically renders an evidence index and injection-safe Markdown report.

It is a 9-node deterministic linear Workflow with 1 governed Tool call and 1 bounded model call — **not** an autonomous document agent, RAG framework, or vector database. See [the proof architecture](../../docs/proofs/document-intelligence.md) and [ADR-028](../../docs/decisions/ADR-028-document-intelligence-proof.md).

## Run the fixture demo

```sh
pnpm proof:document-intelligence
```

The demo is deterministic. It extracts a multi-page document via a fixture document provider and scripted model. It needs no external services, credentials, or network access.

## Use it with your own model and provider

```ts
import { createDocumentIntelligenceProof } from "@aao/example-document-intelligence";

const docIntel = createDocumentIntelligenceProof({
  modelAdapters: [myModelAdapter],       // defineModelAdapter(...) or e.g. defineVercelAiModelAdapter({ model })
  modelBindings: [{ id: "synthesis-model", priority: 10, capabilities: ["model.text_generation", "model.structured_output"], adapterRef: { id: "…", version: "1.0.0" } }],
  documentSourceProvider: myDocProvider, // implements DocumentSourceProvider from @aao/integration-documents
  governance,                            // the principal needs read_only
  principalForRun: ({ runId }) => sessionPrincipal(runId),
});

const outcome = await docIntel.run({
  runId: "doc-run-001",
  request: {
    documentRef: "doc://legal/contract-2026.pdf",
    questions: [
      { id: "governing_law", question: "What is the governing law?" },
      { id: "term", question: "What is the term of the agreement?" },
    ],
  },
});

if (outcome.status === "completed") {
  console.log(outcome.result.markdown);
}
```

- **Model adapter.** Any `ModelAdapter` with structured output support. The Workflow names only the Model Policy `document_intelligence.synthesis`, never a model vendor.
- **Document source provider.** Host code: S3 client, local upload handler, or internal document service. The host owns source storage, byte retrieval, and credentials. Raw bytes never enter Workflow state, trace, evaluation results, or model requests.

## Invariants and Guarantees

- **Provenance Integrity.** Every cited fact points to an exact evidence span ID (`ev.<16-hex>`). The model cites precomputed spans; it never invents page numbers, offsets, or URLs.
- **Zero Raw Bytes in State.** Raw bytes remain within `provider -> Tool handler -> parser`. Run state contains only canonical normalized text and bounded spans.
- **No Branching DSL.** Execution follows a single deterministic 9-node chain.
- **Reference Integrity vs Entailment.** Deterministic validation proves exact reference integrity and bounds; semantic entailment is evaluated independently via model graders or human review.
