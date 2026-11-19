// @aao/example-company-portability — Sprint 25 proof application:
// Company Configuration & Portability demonstrating multi-company composition
// without core forks or duplicated workflow implementations.

export {
  createHostCapabilityCatalog,
  type HostCapabilityCatalog,
  type CreateHostCapabilityCatalogOptions,
} from "./catalog.js";

export {
  createCompanyAAO,
  type ComposedCompanyAAO,
  type CreateCompanyAAOOptions,
  type ProofRegistrationOverride,
  type ProofRegistrationSnapshot,
  type CompanyResearchFacade,
  type DocumentIntelligenceFacade,
  type OperationalRequestFacade,
  type CompanyApprovals,
} from "./composition.js";

export {
  createTrustedHostIdentity,
  createInMemoryRunBindingStore,
  createFileRunBindingStore,
  TrustedRunBindingSchema,
  type AttestedActor,
  type TrustedHostIdentity,
  type TrustedRunBinding,
  type RunBindingStore,
  type RunBindingFailureCode,
} from "./run-binding.js";

export {
  CompanyAdmissionError,
  requireCompanyAdmission,
  REQUIRED_ADMISSION_PERMISSIONS,
  type RequireCompanyAdmissionContext,
} from "./admission.js";

export {
  NORTHSTAR_MANIFEST,
  NORTHSTAR_ACTORS,
  NORTHSTAR_ROLES,
} from "./profiles/northstar-commerce.js";

export {
  ARBOR_MANIFEST,
  ARBOR_ACTORS,
  ARBOR_ROLES,
} from "./profiles/arbor-consulting.js";
