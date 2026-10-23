import type { CapabilityPackManifestV1 } from "../contract.js";
import { defineCapabilityPack, type CapabilityPack } from "../pack.js";

export const DOCUMENT_INTELLIGENCE_PACK_MANIFEST: CapabilityPackManifestV1 = Object.freeze({
  schemaVersion: 1,
  id: "aao.document-intelligence",
  version: "1.0.0",
  name: "Document Intelligence",
  description:
    "Extract bounded PDF/plain-text documents through a governed source integration, preserve deterministic page/span provenance, and produce evidence-anchored structured findings.",
  category: "documents",
  tags: ["document-intelligence", "provenance", "evidence-extraction", "read-only"],
  workflow: {
    id: "document_intelligence.proof",
    version: "1.0.0",
    planFingerprint: "ea415041aa2373ed43238e5da162cb8ceebcc6b5603dba20bab7b3dfbf9fd32c",
  },
  requirements: {
    toolRefs: [
      { id: "document.extract_text", version: "1.0.0" },
    ],
    modelPolicyRefs: [
      "document_intelligence.synthesis",
    ],
    modelCapabilities: ["model.structured_output"],
    integrationSlots: [
      {
        slot: "document_source",
        description: "Governed document source provider for PDF and plain-text documents",
      },
    ],
    preliminaryPermissions: ["read_only" as const],
  },
  execution: {
    outcomeClass: "read_only" as const,
  },
  verification: {
    evalProfileRef: "aao.document-intelligence.evals@1.0.0",
  },
  documentation: {
    summary:
      "Document text extraction and segmentation with evidence anchor validation and structured synthesis.",
    limitations: [
      "No OCR.",
      "No semantic retrieval.",
      "No vector database.",
      "No large-corpus document search.",
      "Citation integrity does not prove semantic entailment.",
      "Hostile PDF sandboxing is not production-complete.",
    ],
  },
});

export const DOCUMENT_INTELLIGENCE_PACK: CapabilityPack = defineCapabilityPack(
  DOCUMENT_INTELLIGENCE_PACK_MANIFEST
);
