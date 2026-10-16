// @aao/example-document-intelligence — the Sprint 23 Document Intelligence proof
// (ADR-028, docs/proofs/document-intelligence.md). A private example
// application, not a Core package: it consumes only @aao/framework and
// @aao/integration-documents, exactly as an external application would.
// No Core package may depend on it.
//
// Fixtures (the deterministic provider and scripted models) live in
// `fixtures/`, outside this entry point.

export { DOCUMENT_INTELLIGENCE_LIMITS, QUESTION_ID_PATTERN, EVIDENCE_ID_PATTERN } from "./limits.js";
export {
  validateDocumentIntelligenceRequest,
  type AdmittedEvidencePacket,
  type CitedEvidenceEntry,
  type DocumentEvidenceSpan,
  type DocumentIntelligenceDraft,
  type DocumentIntelligenceRequest,
  type DocumentIntelligenceRequestInput,
  type DocumentIntelligenceResult,
  type DocumentMetadataSummary,
  type DocumentQuestion,
  type DocumentQuestionInput,
  type DraftAnswer,
  type DraftFinding,
  type GroundedAnswer,
  type GroundedDraft,
  type GroundedFinding,
  type ValidationResult,
} from "./contracts.js";
export {
  GROUNDING_ISSUE_CODES,
  validateDocumentIntelligenceDraft,
  type GroundingIssue,
  type GroundingIssueCode,
  type GroundingValidationResult,
} from "./grounding.js";
export {
  computeEvidenceId,
  segmentDocumentPages,
  validateEvidenceSpans,
  type SpanValidationResult,
} from "./segmentation.js";
export {
  DOCUMENT_INTELLIGENCE_DRAFT_SCHEMA,
  SYNTHESIS_INSTRUCTIONS,
  SYNTHESIS_POLICY_REF,
  buildSynthesisRequest,
} from "./model-requests.js";
export {
  buildDocumentIntelligenceResult,
  escapeMarkdown,
  escapeMarkdownInline,
  formatExcerpt,
  renderDocumentIntelligenceMarkdown,
} from "./render.js";
export {
  DOCUMENT_INTELLIGENCE_EXECUTORS,
  EXECUTOR_VERSION,
  STATE_KEYS,
  intake,
  validateDocument,
  segmentDocument,
  admitEvidence,
  validateGrounding,
  render,
} from "./executors.js";
export {
  DOCUMENT_INTELLIGENCE_NODE_ORDER,
  documentIntelligenceWorkflow,
} from "./workflow.js";
export {
  DOCUMENT_INTELLIGENCE_MODEL_POLICIES,
  createDocumentIntelligenceProof,
  type DocumentIntelligenceProof,
  type DocumentIntelligenceProofOptions,
  type DocumentIntelligenceRunOutcome,
} from "./proof.js";
