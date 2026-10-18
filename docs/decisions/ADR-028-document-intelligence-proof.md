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

Document intelligence follows an established, bounded pipeline: intake, text extraction, document validation, deterministic page-local segmentation with overlap, evidence admission, structured synthesis, grounding validation, and rendering. An open-ended agent or vector-retrieval loop adds non-determinism, cost, and hallucinated provenance.

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
- The model cites precomputed `evidenceId`s from the admitted evidence packet generated via **deterministic page-local segmentation with overlap** (target 1,500 UTF-16 units, 200 unit overlap).
- Offsets are JavaScript UTF-16 code units into canonical normalized page text, guaranteeing that `page.text.slice(startOffset, endOffset)` reconstructs the exact evidence span identically across all runtimes.
- Evidence spans never cross page boundaries and never split Unicode surrogate pairs.

### 3. Integration Fabric: `@aao/integration-documents`

The package `@aao/integration-documents` implements the document extraction capability:
- **No new adapter kind**: Document access is an integration capability, not a model or runtime substrate.
- **Tool**: `document.extract_text@1.0.0` with `permissionClasses: ["read_only"]` and `retrySafety: "safe"`.
- **Supported formats**: `application/pdf` and `text/plain` only (V1). DOCX, XLSX, images, and scanned PDFs requiring OCR are explicitly rejected. Plain-text extraction executes directly in the host process without spawning workers or loading third-party libraries.
- **Isolated worker PDF extraction (Sprint 23C)**:
  - *Root Cause*: The PDF extraction dependency (`unpdf@1.9.0` bundling `pdfjs-dist@~6.4.299`) targets Node >= 22. Under Node 20, PDF.js accesses `Iterator.prototype.join` at module evaluation time, which throws `ReferenceError: Iterator is not defined` because the standard `Iterator` interface was introduced natively in Node 22. Additionally, PDF.js injects browser global stubs (`DOMMatrix`, `navigator`, `pdfjsLib`, etc.) into `globalThis`.
  - *Host-Global Isolation*: Mutating host globals via an import-time shim (`globalThis.Iterator = ...`) is prohibited in AAO. Importing `@aao/integration-documents` must never mutate the host application's global environment or falsely advertise an incomplete Iterator implementation.
  - *Worker Thread Boundary*: PDF parsing is isolated in a dedicated Node worker thread (`node:worker_threads`). The worker executes inside an isolated V8 isolate with its own global scope. The Node 20 `Iterator` compatibility shim and PDF.js browser stubs live strictly inside the worker thread context. The host process `globalThis`, `process.env`, and prototype descriptors remain completely untouched (`before import == after import`, `before parsing == after parsing`).
  - *Verification & Safety*: A fresh Node 20 sub-process test verifies property descriptors before and after import and extraction. A static boundary AST test verifies that production integration modules never assign to `globalThis.*`, allowlisting only `pdf-worker.ts` with an explicit `!isMainThread && parentPort` execution guard.
  - *Resource Bounds & Lifecycle*: PDF parsing is bounded by `AbortSignal.timeout(15_000)` and caller `AbortSignal` cancellation. Defensive buffer copies prevent `ArrayBuffer` detachment. On completion, error, or cancellation, `worker.terminate()` is awaited to guarantee bounded execution with zero worker or memory leaks. Parser errors are strictly normalized (`DOCUMENT_PARSE_FAILED`) with zero stack trace, host path, or credential disclosure.
- **Worker Resource Governance, Admission & Concurrency (Sprint 23D)**:
  - *Process-Wide Admission Controller*: Implements a synchronous, process-wide permit counter scoped to the document integration module. Governs physical worker concurrency across all `createDocumentTools()` instances within the process without storing any document state, refs, credentials, or Run state.
  - *Concurrency Limit*: Hard maximum of `MAX_CONCURRENT_PDF_WORKERS = 2` active worker threads simultaneously across the entire host process. Prevents unbounded thread creation during concurrent runs.
  - *Fail-Fast Admission & Non-Retryable Saturation*: When capacity is saturated, admission fails fast without spinning, queuing, or spawning a worker, returning canonical code `DOCUMENT_PARSER_BUSY`. This failure code is non-retryable by default to prevent automatic retry storms.
  - *Worker V8 Resource Limits*: Configures explicit Node worker `resourceLimits`: `maxOldGenerationSizeMb: 128`, `maxYoungGenerationSizeMb: 32`, `stackSizeMb: 4`. Limits V8 heap/stack memory allocations per worker and normalizes out-of-memory errors (`ERR_WORKER_OUT_OF_MEMORY`) into canonical `DOCUMENT_PARSE_FAILED`.
  - *Node resourceLimits Boundary & Limitations*: Node worker `resourceLimits` bound V8-managed JS heap and stack allocations. They do *not* guarantee a hard limit on external ArrayBuffers, native module allocations, or total host RSS. Hostile-document sandbox hardening and external-memory isolation are explicitly deferred to Sprint 29.
  - *Guaranteed Permit Lifecycle*: Permits are acquired strictly prior to worker instantiation and released in a `try/finally` block only after `worker.terminate()` completes and the worker is fully exited. Prevents capacity leaks on constructor failure, error events, abnormal exits, timeouts, or cancellation races. Double-release protection ensures non-negative worker counts.
  - *Cancellation & Timeout Invariants*: Active caller cancellation via `AbortSignal` immediately requests worker termination, awaits exit, releases permit capacity, and resolves canonical `CANCELLED`. Parsing timeouts (default 15s; bounded positive integer overrides) terminate the worker and resolve `DOCUMENT_PARSE_FAILED`. A boolean settlement guard guarantees cancellation and timeout races cannot double-settle.
  - *Worker Message Boundary Validation*: Deeply validates worker messages (pages array structure, 1..N contiguous page numbering, charCount equality with text length, pagesTotal, pagesExtracted, charactersExtracted, and partialReasons consistency) before accepting extracted state, rejecting malformed responses safely.
  - *Architectural Minimality (No Worker Pool)*: General-purpose worker pools, task queues, or background schedulers were explicitly rejected. A synchronous admission counter provides the smallest reliable architecture: zero background threads idling when no work exists, zero task queue persistence, and complete alignment with AAO's Tool Runtime execution model.
- **Resource bounds**: Hard limits of 10 MiB source bytes, 100 pages, 50,000 chars per page, and 200,000 total extracted characters.
- **Canonical text normalization**: CRLF and CR become LF; NUL characters are stripped. Whitespace is not collapsed, tables are not guessed, and text is not reordered.
- **Document identity**: `doc.` + 16 lowercase hex characters of `SHA-256(rawBytes)`. Unchanged before and after worker isolation.

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
