import type {
  DocumentSourceProvider,
  DocumentSourceProviderContext,
  DocumentSourceReadRequest,
  DocumentSourceReadResponse,
} from "@aao/integration-documents";
import {
  ACME_CONTRACT_PDF_BYTES,
  ACME_DOCUMENT_REF,
  ACME_PLAIN_TEXT_BYTES,
  ACME_TEXT_DOCUMENT_REF,
  SECRET_TOKEN,
} from "./corpus.js";

export interface DocumentFixtureProviderOptions {
  variant?: "a" | "b";
  /** Document refs that return not_found */
  failRefs?: readonly string[];
  /** Document refs that return unavailable */
  unavailableRefs?: readonly string[];
  /** Document refs that return too_large */
  oversizedRefs?: readonly string[];
  /** Document refs that return corrupted PDF bytes */
  corruptedPdfRefs?: readonly string[];
  /** Full provider outage throwing an error with secret credential */
  providerOutage?: boolean;
  /** Custom documents mapped by ref */
  customDocuments?: Readonly<Record<string, { filename?: string; mimeType: string; bytes: Uint8Array }>>;
}

export interface FixtureDocumentProvider extends DocumentSourceProvider {
  readonly calls: readonly { ref: string; signalPresent: boolean }[];
  clearCalls(): void;
}

export function createDocumentFixtureProvider(options: DocumentFixtureProviderOptions = {}): FixtureDocumentProvider {
  const calls: { ref: string; signalPresent: boolean }[] = [];
  const variant = options.variant ?? "a";

  const defaultDocs: Record<string, { filename?: string; mimeType: string; bytes: Uint8Array }> = {
    [ACME_DOCUMENT_REF]: {
      filename: "acme-contract-2026.pdf",
      mimeType: "application/pdf",
      bytes: ACME_CONTRACT_PDF_BYTES,
    },
    [ACME_TEXT_DOCUMENT_REF]: {
      filename: "acme-whitepaper.txt",
      mimeType: "text/plain",
      bytes: ACME_PLAIN_TEXT_BYTES,
    },
    ...(options.customDocuments ?? {}),
  };

  async function read(
    request: DocumentSourceReadRequest,
    context: DocumentSourceProviderContext
  ): Promise<DocumentSourceReadResponse> {
    const ref = request.documentRef;
    calls.push({ ref, signalPresent: Boolean(context.signal) });

    if (options.providerOutage) {
      throw new Error(`Document storage service unreachable token=${SECRET_TOKEN}`);
    }

    if (context.signal?.aborted) {
      throw new Error("Aborted");
    }

    if (options.failRefs?.includes(ref)) {
      return { status: "failed", reason: "not_found" };
    }

    if (options.unavailableRefs?.includes(ref)) {
      return { status: "failed", reason: "unavailable" };
    }

    if (options.oversizedRefs?.includes(ref)) {
      // 11 MiB oversized payload
      return {
        status: "succeeded",
        filename: "oversized.pdf",
        mimeType: "application/pdf",
        bytes: new Uint8Array(11 * 1024 * 1024),
      };
    }

    if (options.corruptedPdfRefs?.includes(ref)) {
      return {
        status: "succeeded",
        filename: "corrupted.pdf",
        mimeType: "application/pdf",
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xee]),
      };
    }

    const doc = defaultDocs[ref];
    if (!doc) {
      return { status: "failed", reason: "not_found" };
    }

    if (variant === "b") {
      // Variant B: extra latency simulation or alternative filename casing
      return {
        status: "succeeded",
        filename: doc.filename?.toUpperCase(),
        mimeType: doc.mimeType,
        bytes: new Uint8Array(doc.bytes), // defensive copy
      };
    }

    return {
      status: "succeeded",
      ...(doc.filename !== undefined ? { filename: doc.filename } : {}),
      mimeType: doc.mimeType,
      bytes: new Uint8Array(doc.bytes),
    };
  }

  return {
    read,
    get calls() {
      return Object.freeze([...calls]);
    },
    clearCalls() {
      calls.length = 0;
    },
  };
}
