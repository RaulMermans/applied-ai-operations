# Document Intelligence proof

Sprint 23 ([ADR-028](../decisions/ADR-028-document-intelligence-proof.md)) establishes AAO's second end-to-end proof application: **Document Intelligence**. Given an opaque document reference and a bounded set of questions, AAO ingests the document through a governed document integration, segments canonical page text via deterministic page-local segmentation with overlap, produces structured answers through a bounded model call, strictly validates every citation against exact precomputed document spans, and deterministically renders an evidence-anchored result.

Code: [`examples/document-intelligence`](../../examples/document-intelligence/README.md) (`@aao/example-document-intelligence`, private). It consumes only public surfaces: `@aao/framework` and `@aao/integration-documents`.

## Architecture

```text
Request
  ↓  intake              deterministic  validate DocumentIntelligenceRequest v1; prepare extract_document input
Document Reference
  ↓  extract_document    tool           document.extract_text@1.0.0 (read_only) via host DocumentSourceProvider
Validate Extracted Document
  ↓  validate_document   deterministic  verify 1..N page numbering, char counts, and deterministic doc.<16-hex> identity
Segmentation
  ↓  segment_document    deterministic  deterministic page-local segmentation with overlap (target 1,500 chars, 200 overlap)
Admission
  ↓  admit_evidence      deterministic  cap context budget (≤ 60 spans, ≤ 60k chars); build synthesis ModelRequest
Synthesis
  ↓  synthesize          model          document_intelligence_draft (structured, strict schema, no Tools)
Grounding Validation
  ↓  validate_grounding  deterministic  citation integrity — check every ref against admitted spans; reject extra fields
Render
  ↓  render              deterministic  DocumentIntelligenceResult v1 + Evidence Index + Markdown
Result
     final               final_output
```

The graph is a single deterministic 9-node chain. There is no branching DSL, if-node, loop, Agent, Approval, vector database, RAG framework, or OCR engine. A successful Run makes exactly 1 governed Tool call and 1 bounded model call.

## Contracts

| Contract | Bounds |
| --- | --- |
| `DocumentIntelligenceRequest` v1 | opaque `documentRef` ≤ 256 chars; 1–8 questions with unique slug ids, ≤ 300 chars each; strict keys |
| `ExtractDocumentOutput` v1 | status (`success` or `partial`), document identity (`doc.<16-hex>`), document fingerprint, 1-based page list, extraction metadata |
| `ExtractedDocumentPage` | `pageNumber` (1..N contiguous), `text` (canonical normalized text), `charCount` (UTF-16 code units) |
| `DocumentEvidenceSpan` | `evidenceId` (`ev.<16-hex>`), `documentId`, `pageNumber`, `startOffset`, `endOffset`, exact `text` |
| `AdmittedEvidencePacket` v1 | ≤ 60 admitted spans, ≤ 60,000 total admitted characters; partial admission surfaced explicitly |
| `DocumentIntelligenceDraft` | one answer per requested question; status (`answered` or `insufficient_evidence`); ≤ 5 findings per answer with 1–5 `evidenceRefs` each; ≤ 5 overall limitations; no URLs or author-authored anchors |
| `DocumentIntelligenceResult` v1 | document summary, questions, answers with cited evidence labels (`E1…En`), evidence index with page/offset/excerpt, coverage, limitations, Markdown |

## Guarantees and Invariants

- **Raw Bytes Never Enter State.** Raw document bytes (`Uint8Array`, `%PDF-1.4`) stay strictly within `provider -> Tool handler -> parser`. Run state, Trace, evaluation results, and model requests receive only canonical normalized text and bounded spans.
- **Evidence Provenance & Offset Semantics.** All offsets are JavaScript UTF-16 code-unit offsets into canonical page text. `page.text.slice(startOffset, endOffset)` reconstructs the exact evidence span identically across all runtimes. Spans never cross page boundaries and never split Unicode surrogate pairs.
- **Citation Integrity vs Entailment.** Every cited reference must match a precomputed `evidenceId` admitted to context. The model cites references; it never invents page numbers, offsets, or URLs. Reference integrity proves exact provenance; it does not prove semantic entailment (which is evaluated separately via graders or human reviewers).
- **Prompt Injection Defense.** Injected text inside a document page remains evidence data in the user message. Constant trusted system instructions prevent role escalation, destructive actions, or fee waivers.
- **Governance & Authorization.** The principal requires `read_only` permission for `document.extract_text`. Without it, execution is denied canonically with zero provider calls.
- **Portability.** The workflow names only the Model Policy `document_intelligence.synthesis` and tool ref `document.extract_text@1.0.0`. It runs identically across native scripted models and the production Vercel AI SDK adapter, and across multiple fixture providers.

## Verification

- **Tests:** `examples/document-intelligence/test` (workflow happy path, grounding validation, segmentation/provenance, error handling & failures, security & injection defense, boundaries, portability, and 27 evaluation cases under `@aao/evaluation`).
- **Integration Tests:** `packages/integration-documents/test` (public API snapshot, tool permissions, PDF text extraction, plain text, and resource bounds).
- **Compiled Smoke Test:** `node examples/document-intelligence/smoke/sprint23.mjs` prints `SPRINT_23_DOCUMENT_INTELLIGENCE_PROOF_SMOKE_OK`.
- **Demo Command:** `pnpm proof:document-intelligence`.
