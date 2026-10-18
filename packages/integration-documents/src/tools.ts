import { defineTool, type JsonValue, type ToolDefinition, type ToolHandlerResult } from "@aao/framework";
import { computeDocumentFingerprint, computeDocumentId } from "./identity.js";
import { DOCUMENT_LIMITS } from "./limits.js";
import { parseDocumentBytes, type ExtractedDocumentPage, type PdfWorkerFactory } from "./parser.js";
import type { DocumentSourceFailureReason, DocumentSourceProvider, DocumentSourceProviderContext, DocumentSourceReadResponse } from "./provider.js";
import { safeSliceUtf16 } from "./text.js";

/** Exact Tool reference. Workflows name this reference; they never name a provider. */
export const DOCUMENT_EXTRACT_TEXT_TOOL_REF = Object.freeze({
  id: "document.extract_text",
  version: "1.0.0",
});

/**
 * Normalized failure codes in Tool output. These are AAO's own vocabulary,
 * never a provider exception, filesystem path, status line, or stack trace.
 */
export type DocumentFailureCode =
  | "DOCUMENT_NOT_FOUND"
  | "DOCUMENT_SOURCE_UNAVAILABLE"
  | "DOCUMENT_TOO_LARGE"
  | "DOCUMENT_TYPE_UNSUPPORTED"
  | "DOCUMENT_NO_EXTRACTABLE_TEXT"
  | "DOCUMENT_PARSE_FAILED"
  | "DOCUMENT_SOURCE_ERROR"
  | "MALFORMED_PROVIDER_RESPONSE"
  | "CANCELLED"
  | "INVALID_DOCUMENT_REF"
  | "DOCUMENT_PARSER_BUSY";

const REASON_CODES: Readonly<Record<DocumentSourceFailureReason, DocumentFailureCode>> = Object.freeze({
  not_found: "DOCUMENT_NOT_FOUND",
  unavailable: "DOCUMENT_SOURCE_UNAVAILABLE",
  too_large: "DOCUMENT_TOO_LARGE",
  unsupported_type: "DOCUMENT_TYPE_UNSUPPORTED",
});

export interface ExtractDocumentInput {
  readonly documentRef: string;
}

export interface ExtractedDocumentData {
  readonly documentId: string;
  readonly documentFingerprint: string;
  readonly filename?: string;
  readonly mimeType: string;
  readonly pages: readonly ExtractedDocumentPage[];
}

export interface ExtractedDocumentMeta {
  readonly bytesRead: number;
  readonly pagesTotal: number;
  readonly pagesExtracted: number;
  readonly charactersExtracted: number;
  readonly partialReasons: readonly string[];
}

export interface ExtractDocumentOutput {
  readonly status: "success" | "partial";
  readonly data: ExtractedDocumentData;
  readonly meta: ExtractedDocumentMeta;
}

export interface DocumentToolsOptions {
  /** Trusted host-supplied provider that resolves document references to raw bytes. */
  readonly provider: DocumentSourceProvider;
  /** @internal Private test seam for worker lifecycle testing. */
  readonly _workerFactory?: PdfWorkerFactory;
}

export interface DocumentTools {
  readonly extractText: ToolDefinition;
}

// --- JSON Schemas ------------------------------------------------------------

const EXTRACT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    documentRef: {
      type: "string",
      minLength: 1,
      maxLength: DOCUMENT_LIMITS.maxDocumentRefLength,
      description: "Opaque, host-controlled document reference.",
    },
  },
  required: ["documentRef"],
  additionalProperties: false,
};

const EXTRACT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["success", "partial"] },
    data: {
      type: "object",
      properties: {
        documentId: { type: "string", pattern: "^doc\\.[a-f0-9]{16}$" },
        documentFingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
        filename: { type: "string", minLength: 1, maxLength: DOCUMENT_LIMITS.maxFilenameLength },
        mimeType: { type: "string", minLength: 1, maxLength: DOCUMENT_LIMITS.maxMimeTypeLength },
        pages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              pageNumber: { type: "integer", minimum: 1 },
              text: { type: "string" },
              charCount: { type: "integer", minimum: 0 },
            },
            required: ["pageNumber", "text", "charCount"],
            additionalProperties: false,
          },
        },
      },
      required: ["documentId", "documentFingerprint", "mimeType", "pages"],
      additionalProperties: false,
    },
    meta: {
      type: "object",
      properties: {
        bytesRead: { type: "integer", minimum: 0 },
        pagesTotal: { type: "integer", minimum: 0 },
        pagesExtracted: { type: "integer", minimum: 0 },
        charactersExtracted: { type: "integer", minimum: 0 },
        partialReasons: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["bytesRead", "pagesTotal", "pagesExtracted", "charactersExtracted", "partialReasons"],
      additionalProperties: false,
    },
  },
  required: ["status", "data", "meta"],
  additionalProperties: false,
};

const NO_SIDE_EFFECTS = "Read-only: reads document content through the host-supplied provider and performs no mutation, network call, or external side effect.";
const FAILURE_DOCS = "Provider or parser failures are normalized into safe uppercase codes. When the source is unavailable, the Tool fails with retryable code DOCUMENT_SOURCE_UNAVAILABLE; Runtime reliability policy decides whether to retry. When PDF parser capacity is exhausted, the Tool fails with non-retryable code DOCUMENT_PARSER_BUSY.";

// --- Tool handler ------------------------------------------------------------

async function extractTextHandler(
  provider: DocumentSourceProvider["read"],
  input: ExtractDocumentInput,
  context: DocumentSourceProviderContext,
  workerFactory?: PdfWorkerFactory
): Promise<ToolHandlerResult> {
  const documentRef = typeof input?.documentRef === "string" ? input.documentRef.trim() : "";
  if (documentRef.length === 0 || documentRef.length > DOCUMENT_LIMITS.maxDocumentRefLength) {
    return { ok: false, code: "INVALID_DOCUMENT_REF" };
  }

  if (context.signal?.aborted) {
    return { ok: false, code: "CANCELLED" };
  }

  let readResponse: DocumentSourceReadResponse;
  try {
    readResponse = await provider({ documentRef }, context);
  } catch {
    // Redact any thrown exception / provider token / network error completely
    return { ok: false, code: "DOCUMENT_SOURCE_ERROR" };
  }

  if (readResponse === null || typeof readResponse !== "object" || Array.isArray(readResponse)) {
    return { ok: false, code: "MALFORMED_PROVIDER_RESPONSE" };
  }

  if (readResponse.status === "failed") {
    const reason = readResponse.reason;
    if (typeof reason === "string" && Object.prototype.hasOwnProperty.call(REASON_CODES, reason)) {
      const code = REASON_CODES[reason as DocumentSourceFailureReason];
      return { ok: false, code, retryable: code === "DOCUMENT_SOURCE_UNAVAILABLE" ? true : undefined };
    }
    return { ok: false, code: "MALFORMED_PROVIDER_RESPONSE" };
  }

  if (readResponse.status !== "succeeded") {
    return { ok: false, code: "MALFORMED_PROVIDER_RESPONSE" };
  }

  const { bytes, mimeType, filename } = readResponse;
  if (!(bytes instanceof Uint8Array)) {
    return { ok: false, code: "MALFORMED_PROVIDER_RESPONSE" };
  }

  if (typeof mimeType !== "string" || mimeType.trim().length === 0) {
    return { ok: false, code: "DOCUMENT_TYPE_UNSUPPORTED" };
  }

  if (bytes.length > DOCUMENT_LIMITS.maxDocumentBytes) {
    return { ok: false, code: "DOCUMENT_TOO_LARGE" };
  }

  // Compute canonical identity from raw bytes BEFORE parsing
  const documentFingerprint = computeDocumentFingerprint(bytes);
  const documentId = computeDocumentId(documentFingerprint);

  // Parse document bytes
  const parsed = await parseDocumentBytes(bytes, mimeType, {
    signal: context.signal,
    ...(workerFactory !== undefined ? { _workerFactory: workerFactory } : {}),
  });
  if (!parsed.ok) {
    return { ok: false, code: parsed.code };
  }

  const cleanFilename =
    typeof filename === "string" && filename.trim().length > 0
      ? safeSliceUtf16(filename.trim(), DOCUMENT_LIMITS.maxFilenameLength)
      : undefined;

  const cleanMimeType = safeSliceUtf16(mimeType.trim().toLowerCase(), DOCUMENT_LIMITS.maxMimeTypeLength);

  const output: ExtractDocumentOutput = {
    status: parsed.isPartial ? "partial" : "success",
    data: {
      documentId,
      documentFingerprint,
      ...(cleanFilename !== undefined ? { filename: cleanFilename } : {}),
      mimeType: cleanMimeType,
      pages: parsed.pages,
    },
    meta: {
      bytesRead: bytes.length,
      pagesTotal: parsed.pagesTotal,
      pagesExtracted: parsed.pagesExtracted,
      charactersExtracted: parsed.charactersExtracted,
      partialReasons: parsed.partialReasons,
    },
  };

  return { ok: true, output: output as unknown as JsonValue };
}

/**
 * Creates the document extraction Tool around one host-supplied DocumentSourceProvider.
 *
 * It is a normal AAO Tool definition (`defineTool`). Execution passes through the
 * canonical Tool Registry, permission gate, Authorization, schemas, Trace, and Runtime reliability.
 *
 * Permission: `read_only`.
 * Retry safety: `safe`.
 */
export function createDocumentTools(options: DocumentToolsOptions): DocumentTools {
  const provider = options?.provider;
  const readFn = provider?.read;
  if (typeof readFn !== "function") {
    throw new TypeError("createDocumentTools requires a provider with a read() function");
  }

  const workerFactory = options?._workerFactory;
  const boundRead: DocumentSourceProvider["read"] = (request, context) => readFn.call(provider, request, context);
  const contextOf = (signal: AbortSignal | undefined): DocumentSourceProviderContext =>
    Object.freeze(signal ? { signal } : {});

  const extractTool = defineTool({
    spec: {
      schemaVersion: 1,
      ...DOCUMENT_EXTRACT_TEXT_TOOL_REF,
      name: "Extract document text",
      description: `Ingests a bounded document by opaque reference through the host's DocumentSourceProvider and extracts canonical page text. Computes deterministic document identity from raw bytes and preserves 1-based page numbering. Supports application/pdf and text/plain. Raw bytes never enter Run state. ${FAILURE_DOCS} ${NO_SIDE_EFFECTS}`,
      inputSchema: EXTRACT_INPUT_SCHEMA,
      outputSchema: EXTRACT_OUTPUT_SCHEMA,
      permissionClasses: ["read_only"],
    },
    handler: {
      execute: async ({ input, signal }) =>
        extractTextHandler(boundRead, input as unknown as ExtractDocumentInput, contextOf(signal), workerFactory),
    },
    retrySafety: "safe",
  });

  return Object.freeze({ extractText: extractTool });
}
