# ADR-028: Document Intelligence Proof, Bounded Document Ingestion, and Page/Span Provenance

Status: accepted (Sprint 23)

## Context

Sprint 22 established AAO's first proof application (Company Research) and demonstrated how Integration Fabric tools (`@aao/integration-public-web`) and Toolbox utilities (`@aao/toolbox`) compose under Governance and Trace.

Sprint 23 builds AAO's second major end-to-end proof: **Document Intelligence**. Given a bounded document and a set of business questions, AAO must ingest and extract the document through a governed document integration, preserve deterministic page/span provenance, use a bounded model call to produce structured findings, validate every evidence reference against exact precomputed document spans, and render a reproducible evidence-anchored result.

A key mandate of Sprint 23 is to prove that AAO can operate on uploaded or enterprise documents without introducing:
- a generic RAG framework;
- a vector database or embedding models;
- OCR infrastructure;
- a document-memory system;
- an autonomous document agent;
- a generic mapping DSL;
- a generic branching or conditional routing DSL.

## Decision

### 1. Workflow plus Governed Tools, Not a Document Agent or RAG Pipeline

Document intelligence follows an established, bounded pipeline: intake, text extraction, document validation, page segmentation, evidence admission, structured synthesis, grounding validation, and rendering. An open-ended agent or vector-retrieval loop adds non-determinism, cost, and hallucinated provenance.

Therefore, Document Intelligence is a single deterministic 9-node Workflow (`document_intelligence.proof@1.0.0`):
- **1 governed Tool call**: `document.extract_text@1.0.0` (Integration Fabric).
- **1 bounded model call**: `document_intelligence.synthesis` (Model Runtime).
- **7 deterministic nodes**: `intake`, `validate_document`, `segment_document`, `admit_evidence`, `validate_grounding`, `render`, `final`.

### 2. Resolution of the Sprint 22 Handoff Decisions

#### 2.1 Conditional routing: Not added in Sprint 23
We do not introduce an `if` node, conditional branching DSL, JSONPath expressions, or condition syntax in Sprint 23.
- Ingestion or validation failures halt execution deterministically before model invocation.
- Valid documents execute a single bounded linear pipeline.
- The proof succeeds reliably without branching. Generic branching requires multi-workflow evidence before considering DSL additions.

#### 2.2 Document input boundary: Opaque references and host-provided bytes
The Workflow receives an opaque `documentRef` (e.g. `doc://legal/contract.pdf`), never raw bytes, base64 strings, filesystem paths, or URLs.
- A host-supplied `DocumentSourceProvider` resolves the reference into bounded bytes inside the document integration.
- **Inviolable Invariant**: Raw document bytes (`Uint8Array`, `%PDF-1.4`) remain strictly inside `provider -> Tool handler -> parser`. They **never** enter Workflow Run state, Trace, evaluation results, or model prompts.
- Host owns storage, credentials, and access control. AAO owns tool schemas, limits, normalization, identity, and governance.

#### 2.3 Evidence identity and provenance
Document citations resolve to deterministic evidence-span IDs:
`ev.` + 16 lowercase hex characters of `SHA-256(fingerprint + ":" + pageNumber + ":" + startOffset + ":" + endOffset + ":" + SHA-256(text))`.
- The model **never** authors page numbers, UTF-16 offsets, URLs, or document IDs.
- The model cites precomputed `evidenceId`s from the admitted evidence packet.
- Offsets are JavaScript UTF-16 code units into canonical normalized page text, guaranteeing that `page.text.slice(startOffset, endOffset)` reconstructs the exact evidence span identically across all runtimes.
- Evidence spans never cross page boundaries and never split Unicode surrogate pairs.

### 3. Integration Fabric: `@aao/integration-documents`

The package `@aao/integration-documents` implements the document extraction capability:
- **No new adapter kind**: Document access is an integration capability, not a model or runtime substrate.
- **Tool**: `document.extract_text@1.0.0` with `permissionClasses: ["read_only"]` and `retrySafety: "safe"`.
- **Supported formats**: `application/pdf` and `text/plain` only (V1). DOCX, XLSX, images, and scanned PDFs requiring OCR are explicitly rejected.
- **Node-compatible local parser**: `unpdf` (pure ESM, zero external dependencies, no canvas/native binaries, no remote asset fetching, no script execution). Defensive buffer copying is implemented to prevent PDF.js from detaching the host's ArrayBuffer. A minimal `Iterator` safeguard ensures compatibility with Node 20.
- **Resource bounds**: Hard limits of 10 MiB source bytes, 100 pages, 50,000 chars per page, and 200,000 total extracted characters.
- **Canonical text normalization**: CRLF and CR become LF; NUL characters are stripped. Whitespace is not collapsed, tables are not guessed, and text is not reordered.
- **Document identity**: `doc.` + 16 lowercase hex characters of `SHA-256(rawBytes)`.

### 4. Strict Grounding Validation: Reference Integrity vs Entailment

The `validate_grounding` deterministic node executes `validateDocumentIntelligenceDraft`:
- Every requested question must be answered exactly once; extra questions are rejected.
- An `answered` question requires 1–5 findings, each citing 1–5 valid admitted `evidenceId`s.
- An `insufficient_evidence` question requires 0 findings and an explicit limitation.
- Forged references, duplicate references within a finding, and unauthorized metadata authoring fail validation immediately.
- The model draft schema enforces `additionalProperties: false` throughout.

> **Provenance Guarantee**: Reference integrity proves that cited text exists in admitted document evidence at exact offsets. It does **not** evaluate semantic entailment (whether the cited text logically supports the claim). Semantic entailment is evaluated independently via model judges or human reviewers.

### 5. Deterministic Markdown Rendering

The final report is rendered deterministically by code (`buildDocumentIntelligenceResult`), not by the model:
- Citation markers `[E1]`, `[E2]`, etc. are assigned in order of appearance across findings.
- An **Evidence Index** lists each cited span with its citation ID, page number, character offsets, and blockquoted excerpt.
- `escapeMarkdownInline` escapes HTML tags, script tags, javascript links, and markdown syntax to neutralize prompt-injection and XSS vectors.

## Consequences

- AAO now has two comprehensive proof applications (`@aao/example-company-research` and `@aao/example-document-intelligence`) proving governed external Tool use, deterministic extraction, and exact evidence provenance.
- The Workflow runs identically across native scripted models and the production Vercel AI SDK adapter, and across multiple fixture providers.
- Bounded document processing is achieved without vector databases, RAG frameworks, or OCR infrastructure.
- 27 verification cases run under the canonical Evaluation Runtime (`@aao/evaluation`) using standard deterministic graders.
