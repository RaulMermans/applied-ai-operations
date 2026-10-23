// @aao/example-company-research — the Sprint 22 Company Research proof
// (ADR-027, docs/proofs/company-research.md). A private example
// application, not a Core package: it consumes only @aao/framework,
// @aao/toolbox, and @aao/integration-public-web, exactly as an external
// application would. No Core package may depend on it.
//
// Fixtures (the deterministic provider and scripted models) live in
// `fixtures/`, outside this entry point.

export { COMPANY_RESEARCH_LIMITS } from "./limits.js";
export {
  validateCompanyResearchRequest,
  validateResearchPlan,
  type AnswerStatus,
  type CompanyResearchDraft,
  type CompanyResearchRequest,
  type CompanyResearchRequestInput,
  type CompanyResearchResult,
  type CompanyResearchSourceEntry,
  type EvidenceSummary,
  type GroundedReport,
  type ResearchPlan,
  type ResearchSource,
  type ResearchSourcePacket,
  type Validation,
} from "./contracts.js";
export { GROUNDING_ISSUE_CODES, validateCompanyResearchDraft, type GroundingIssue, type GroundingIssueCode, type GroundingValidation } from "./grounding.js";
export { COMPANY_RESEARCH_DRAFT_SCHEMA, PLANNING_INSTRUCTIONS, PLANNING_POLICY_REF, RESEARCH_PLAN_SCHEMA, SYNTHESIS_INSTRUCTIONS, SYNTHESIS_POLICY_REF, buildPlanningRequest, buildSynthesisRequest } from "./model-requests.js";
export { buildCompanyResearchResult, escapeMarkdownInline, evidenceLimitations, renderCompanyResearchMarkdown } from "./render.js";
export { COMPANY_RESEARCH_EXECUTORS, STATE_KEYS } from "./executors.js";
export { COMPANY_RESEARCH_NODE_ORDER, DEDUPE_TOOL_REF, PROJECT_TOOL_REF, companyResearchWorkflow } from "./workflow.js";
export { COMPANY_RESEARCH_MODEL_POLICIES, createCompanyResearchProof, type CompanyResearchProof, type CompanyResearchProofOptions, type CompanyResearchRunOutcome, type ProofRegistrationSnapshot } from "./proof.js";
