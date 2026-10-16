/**
 * The document source provider port: the minimal host-facing port that resolves
 * an opaque document reference into raw bounded document bytes (Sprint 23, ADR-028).
 *
 * This port is a narrow domain port inside this integration, not an `AdapterManifest`
 * and not a new AAO adapter kind.
 *
 * The provider owns how a reference maps to bytes (local upload, object storage,
 * database blob, connector). AAO owns schema validation, bounds, normalization,
 * document identity, fingerprinting, page text contracts, and failure semantics.
 *
 * Provider data is untrusted: `filename` and `mimeType` are advisory display/routing hints,
 * while `documentId`, `documentFingerprint`, page numbers, and evidence IDs are computed
 * exclusively by AAO.
 */
export interface DocumentSourceProvider {
  /** Reads one document by opaque reference. Called at most once per document.extract_text execution. */
  read(request: DocumentSourceReadRequest, context: DocumentSourceProviderContext): Promise<DocumentSourceReadResponse>;
}

/**
 * The trusted execution context of one provider call. `signal` is the Tool
 * Runtime's canonical cancellation signal for the Tool execution (e.g. attempt timeout),
 * passed through unchanged when available.
 */
export interface DocumentSourceProviderContext {
  readonly signal?: AbortSignal;
}

export interface DocumentSourceReadRequest {
  /**
   * An opaque, bounded, host-controlled document reference.
   * Must never be interpreted by the integration as a filesystem path, URL, shell command, or query.
   */
  readonly documentRef: string;
}

export interface DocumentSourceReadSuccess {
  readonly status: "succeeded";
  /** Optional display filename provided by the host. Untrusted metadata. */
  readonly filename?: string;
  /** MIME type of the document (e.g. application/pdf, text/plain). */
  readonly mimeType: string;
  /** Raw document bytes. Never enters canonical Workflow state or Trace. */
  readonly bytes: Uint8Array;
}

export interface DocumentSourceReadFailure {
  readonly status: "failed";
  readonly reason: DocumentSourceFailureReason;
}

export type DocumentSourceReadResponse = DocumentSourceReadSuccess | DocumentSourceReadFailure;

/**
 * The bounded failure reasons a DocumentSourceProvider may report.
 * A thrown error, rejected promise, or unexpected status is never leaked:
 * it becomes a normalized DOCUMENT_SOURCE_ERROR or MALFORMED_PROVIDER_RESPONSE.
 */
export type DocumentSourceFailureReason = "not_found" | "unavailable" | "too_large" | "unsupported_type";
