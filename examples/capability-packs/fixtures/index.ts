import type { CompanyPackSelectionV1 } from "@aao/capability-packs";
import {
  createTestHostEnvironment,
  NORTHSTAR_MANIFEST,
  ARBOR_MANIFEST,
  NORTHSTAR_ACTORS,
  ARBOR_ACTORS,
  OVERLAPPING_DOC_REF,
  NORTHSTAR_OPERATIONAL_REQUEST,
  ARBOR_OPERATIONAL_REQUEST,
  createCompanyApprovalVerifier,
  type TestHostEnvironment,
} from "@aao/example-company-portability/fixtures";

export {
  createTestHostEnvironment,
  NORTHSTAR_MANIFEST,
  ARBOR_MANIFEST,
  NORTHSTAR_ACTORS,
  ARBOR_ACTORS,
  OVERLAPPING_DOC_REF,
  NORTHSTAR_OPERATIONAL_REQUEST,
  ARBOR_OPERATIONAL_REQUEST,
  createCompanyApprovalVerifier,
  type TestHostEnvironment,
};

export const NORTHSTAR_PACK_SELECTION: Readonly<CompanyPackSelectionV1> = Object.freeze({
  schemaVersion: 1,
  companyId: "northstar-commerce",
  packRefs: [
    { id: "aao.company-research", version: "1.0.0" },
    { id: "aao.document-intelligence", version: "1.0.0" },
    { id: "aao.operational-request", version: "1.0.0" },
  ],
});

export const ARBOR_PACK_SELECTION: Readonly<CompanyPackSelectionV1> = Object.freeze({
  schemaVersion: 1,
  companyId: "arbor-consulting",
  packRefs: [
    { id: "aao.company-research", version: "1.0.0" },
    { id: "aao.document-intelligence", version: "1.0.0" },
    { id: "aao.operational-request", version: "1.0.0" },
  ],
});

export const NORTHSTAR_RESEARCH_REQUEST = Object.freeze({
  company: { name: "Northstar Commerce", domain: "northstar.example" },
  questions: [
    { id: "offering", question: "What does Northstar Commerce offer?" },
    { id: "customers", question: "Who are its target customers?" },
    { id: "differentiation", question: "How does it differentiate?" },
  ],
});

export const ARBOR_RESEARCH_REQUEST = Object.freeze({
  company: { name: "Arbor Consulting", domain: "arbor.example" },
  questions: [
    { id: "offering", question: "What services does Arbor Consulting provide?" },
    { id: "clients", question: "Who are its target clients?" },
    { id: "differentiation", question: "What differentiates its practice?" },
  ],
});

export const NORTHSTAR_DOC_REQUEST = Object.freeze({
  documentRef: OVERLAPPING_DOC_REF,
  questions: [{ id: "terms", question: "What are the payment terms?" }],
});

export const ARBOR_DOC_REQUEST = Object.freeze({
  documentRef: OVERLAPPING_DOC_REF,
  questions: [{ id: "terms", question: "What are the consulting fees?" }],
});
