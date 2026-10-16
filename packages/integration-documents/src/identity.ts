import { createHash } from "node:crypto";

/** Regex pattern for canonical document ids: `doc.` followed by 16 lowercase hex characters. */
export const DOCUMENT_ID_PATTERN = /^doc\.[a-f0-9]{16}$/;

/** Regex pattern for canonical SHA-256 document fingerprints (64 lowercase hex characters). */
export const DOCUMENT_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Computes the canonical document fingerprint: SHA-256 of the exact raw document bytes.
 * This establishes content-based identity before parsing, completely independent of filenames,
 * document references, storage locations, or provider identities.
 */
export function computeDocumentFingerprint(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Derives the canonical AAO document ID from the document fingerprint:
 * `doc.` + first 16 hex characters of the SHA-256 fingerprint.
 */
export function computeDocumentId(fingerprint: string): string {
  if (!DOCUMENT_FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new TypeError(`computeDocumentId requires a 64-character hex fingerprint, received: ${fingerprint}`);
  }
  return `doc.${fingerprint.slice(0, 16)}`;
}
