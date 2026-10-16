# @aao/integration-documents

AAO **Integration Fabric** capability: bounded document ingestion and canonical page text extraction, exposed as a normal, governed AAO Tool around a host-supplied `DocumentSourceProvider`.

```text
createDocumentTools({ provider })  →  document.extract_text  (normal ToolDefinition)
   → createAAO({ tools }) → Tool Registry → Tool Runtime
   → support gate → Authorization (read_only) → input schema → handler → provider → parsing/normalization → output schema
```

This package is not a Tool Runtime, not an adapter kind, and not part of the Toolbox. It performs no network access itself, introduces no vector database or RAG machinery, and names no vendor SDK. Importing it registers nothing.

## Quickstart

```ts
import { createAAO } from "@aao/framework";
import { createDocumentTools, type DocumentSourceProvider } from "@aao/integration-documents";

// Your host code owns the provider: local upload, object storage, database blob, or connector.
const provider: DocumentSourceProvider = {
  async read({ documentRef }, { signal }) {
    // Resolve opaque reference to raw bounded bytes
    return {
      status: "succeeded",
      filename: "sample.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array([/* ... */]),
    };
  },
};

const docTools = createDocumentTools({ provider });
const app = createAAO({ governance, principalForRun, tools: [docTools.extractText] });
```

A Workflow `tool` node references `{ id: "document.extract_text", version: "1.0.0" }`. The principal needs `read_only`. Without it, the Tool Runtime denies the call and the provider is never invoked.

## The Tool

| Tool | Input | Output |
| --- | --- | --- |
| `document.extract_text@1.0.0` | `documentRef` (1–256 chars, opaque host reference) | `status` (`success`, `partial`), `data` (`documentId`, `documentFingerprint`, optional `filename`, `mimeType`, `pages[]` with 1-based `pageNumber`, `text`, `charCount`), `meta` (`bytesRead`, `pagesTotal`, `pagesExtracted`, `charactersExtracted`, `partialReasons[]`) |

The Tool is `read_only`, declared retry-safe (reading a document has no side effect), and validated by the Tool Runtime's strict input and output schemas.

## Semantics

- **Opaque documentRef.** The Workflow receives an opaque reference string, never a raw filesystem path, file:// URL, shell command, or query.
- **Raw bytes privacy.** Raw document bytes stay inside the provider and Tool handler; they never enter Run state, Trace, or the final result.
- **Document identity is AAO's.** `documentFingerprint` is the SHA-256 hash of the exact raw document bytes. `documentId` is `doc.` plus the first 16 hex characters of the fingerprint. Identity is derived strictly from bytes, never filenames or references.
- **Supported formats.** `application/pdf` and `text/plain` only. All other formats fail explicitly with `DOCUMENT_TYPE_UNSUPPORTED`. No OCR is performed.
- **Bounded resources.** Hard limit of 10 MiB raw bytes, 100 pages, 50,000 UTF-16 units per page, and 200,000 UTF-16 units total.
- **Canonical UTF-16 offsets.** All document offsets are JavaScript UTF-16 code-unit offsets into canonical page text, ensuring `page.text.slice(startOffset, endOffset)` reconstructs the exact evidence span.
- **Failures.** Normalized failure codes include `DOCUMENT_NOT_FOUND`, `DOCUMENT_SOURCE_UNAVAILABLE` (retryable), `DOCUMENT_TOO_LARGE`, `DOCUMENT_TYPE_UNSUPPORTED`, `DOCUMENT_NO_EXTRACTABLE_TEXT`, and `DOCUMENT_PARSE_FAILED`.

See [ADR-028](../../docs/decisions/ADR-028-document-intelligence-proof.md) and [Integration Fabric](../../docs/architecture/integration-fabric.md).
