import type { CapabilityPackManifestV1 } from "../contract.js";
import { defineCapabilityPack, type CapabilityPack } from "../pack.js";

export const COMPANY_RESEARCH_PACK_MANIFEST: CapabilityPackManifestV1 = Object.freeze({
  schemaVersion: 1,
  id: "aao.company-research",
  version: "1.0.0",
  name: "Company Research",
  description:
    "Research a company using governed public-web capabilities, bounded model planning/synthesis, and deterministic source-grounding validation.",
  category: "research",
  tags: ["company-research", "public-web", "grounding", "read-only"],
  workflow: {
    id: "company_research.proof",
    version: "1.0.0",
    planFingerprint: "d316887874d40e7218ee0dbce3392db29ba8a666b36dcd5d513ebf0a885c2919",
  },
  requirements: {
    toolRefs: [
      { id: "public_web.search", version: "1.0.0" },
      { id: "records.dedupe", version: "1.0.0" },
      { id: "public_web.fetch_pages", version: "1.0.0" },
      { id: "records.project", version: "1.0.0" },
    ],
    modelPolicyRefs: [
      "company_research.planning",
      "company_research.synthesis",
    ],
    modelCapabilities: ["model.structured_output"],
    integrationSlots: [
      {
        slot: "public_web",
        description: "Governed public-web provider for search and page fetching",
      },
    ],
    preliminaryPermissions: ["read_only" as const],
  },
  execution: {
    outcomeClass: "read_only" as const,
  },
  verification: {
    evalProfileRef: "aao.company-research.evals@1.0.0",
  },
  documentation: {
    summary:
      "Grounded company research using public-web search, deduplication, page fetching, structured synthesis, and deterministic citation validation.",
    limitations: [
      "No guarantee that cited sources semantically entail every claim.",
      "No private-company system access.",
      "No autonomous browsing beyond existing bounded Workflow.",
      "No uncontrolled network capability.",
      "No external side effects.",
    ],
  },
});

export const COMPANY_RESEARCH_PACK: CapabilityPack = defineCapabilityPack(COMPANY_RESEARCH_PACK_MANIFEST);
