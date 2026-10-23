# Guide: Using Capability Packs in Applied AI Operations

This guide explains how to discover, inspect, select, validate, compose, execute, and evaluate **Capability Packs** (`@aao/capability-packs`) in Applied AI Operations (AAO).

---

## 1. What Is a Capability Pack?

A **Capability Pack** is a strictly versioned, immutable, JSON-safe declarative contract (`CapabilityPackManifestV1`) that packages an existing, proven AAO workflow together with its exact operational dependencies:

- Exact workflow identity and deterministic `planFingerprint`
- Exact governed Tool references (`id@version`)
- Exact Model Policy references (`id@version`) and required model capabilities
- Required host integration slots (`publicWebProviderRef`, `documentSourceRef`, `draftRepositoryRef`)
- Preliminary Governance permission classes (`read_only`, `write_draft`)
- Optional human Approval requirements (`actionClass`, `approverRoles`, `forbidSelfApproval`)
- Supported execution outcome class (`read_only` or `draft_only`)
- Canonical Evaluation profile reference (`evalProfileRef`)
- Human-readable adoption summary and explicit non-goals (`limitations`)

A Capability Pack is **declarative metadata**. It is not an Agent, a new workflow runtime, a plugin loader, or a bypass around Governance.

---

## 2. When Should I Use a Pack vs. Writing a Custom Workflow?

| Scenario | Recommended Approach |
|---|---|
| You need a standard governed business operation (Company Research, Document Intelligence, Operational Request) across one or more companies | **Use an existing Capability Pack** (`@aao/capability-packs`) |
| You have built and proven a deterministic workflow in AAO and want multiple companies or business units to adopt it with preflight compatibility checks | **Define a new Capability Pack** wrapping that workflow |
| You are designing a novel sequence of governed steps, tools, and schema validations for the first time | **Write a deterministic AAO Workflow first**, prove its runtime and Evaluation profile, and then package it as a Capability Pack |

Always follow the AAO rule: **Workflow before Capability Pack; Capability Pack before multi-company rollout.**

---

## 3. How Do I Inspect a Pack's Requirements?

Use `createCapabilityPackCatalog` from `@aao/capability-packs` (or `createStandardPackCatalog` from `@aao/example-capability-packs`) to list, search, and describe registered packs:

```ts
import {
  createCapabilityPackCatalog,
  COMPANY_RESEARCH_PACK,
  DOCUMENT_INTELLIGENCE_PACK,
  OPERATIONAL_REQUEST_PACK,
} from "@aao/capability-packs";

const catalog = createCapabilityPackCatalog([
  COMPANY_RESEARCH_PACK,
  DOCUMENT_INTELLIGENCE_PACK,
  OPERATIONAL_REQUEST_PACK,
]);

// List all packs in deterministic code-unit order
const allPacks = catalog.listCapabilityPacks();

// Search by category, tag, or outcome class
const readOnlyPacks = catalog.searchCapabilityPacks({
  outcomeClass: "read_only",
});

// Inspect human-readable and structured requirements
const descriptor = catalog.describeCapabilityPack("aao.operational-request@1.0.0");
console.log(descriptor.packRef); // "aao.operational-request@1.0.0"
console.log(descriptor.workflowPlanFingerprint);
console.log(descriptor.toolRefs);
console.log(descriptor.integrationSlots);
console.log(descriptor.approval);
```

---

## 4. How Do I Select Packs for a Company?

A company declares which exact Capability Pack versions it wants to activate using `CompanyPackSelectionV1` and validates the contract via `validateCompanyPackSelection()`:

```ts
import { validateCompanyPackSelection } from "@aao/capability-packs";

const selection = validateCompanyPackSelection({
  schemaVersion: 1,
  companyId: "northstar-commerce",
  packRefs: [
    { id: "aao.company-research", version: "1.0.0" },
    { id: "aao.document-intelligence", version: "1.0.0" },
    { id: "aao.operational-request", version: "1.0.0" },
  ],
});
```

Selection rules:
- Every pack reference must use an exact `MAJOR.MINOR.PATCH` version (no `latest`, `^`, `~`, or wildcards).
- Duplicate pack references are rejected with `PACK_DUPLICATE_REF`.
- Unknown fields are rejected with `PACK_INVALID_MANIFEST`.

---

## 5. How Do I Validate Compatibility?

Before activating or running any pack, run `validatePackCompatibility(pack, context)` using the trusted `ProofRegistrationSnapshot` from the composed proof and the verified `PackEvalProfileCatalog`:

```ts
import {
  OPERATIONAL_REQUEST_PACK,
  validatePackCompatibility,
} from "@aao/capability-packs";
import { createStandardEvalProfileCatalog } from "@aao/example-capability-packs";

const evalCatalog = createStandardEvalProfileCatalog();
const proofSnapshot = northstarAAO.getOperationalRequestProof().registrationSnapshot;

const report = validatePackCompatibility(OPERATIONAL_REQUEST_PACK, {
  companyId: "northstar-commerce",
  enabledProofs: ["company_research", "document_intelligence", "operational_request"],
  governanceRoles: [
    { id: "operations.requester" },
    { id: "operations.approver" },
  ],
  integrations: {
    draftRepositoryRef: "repo.northstar.drafts",
  },
  workflow: proofSnapshot.workflow,
  registeredTools: proofSnapshot.tools,
  registeredModelPolicies: proofSnapshot.modelPolicies,
  registeredModelBindings: proofSnapshot.modelBindings,
  registeredModelAdapters: proofSnapshot.modelAdapters,
  registeredEvalProfiles: evalCatalog.listProfileRefs(),
});

console.log(report.compatible); // true
console.log(report.verifiedRequirements);
```

All registration evidence fields (`registeredTools`, `registeredModelPolicies`, `registeredModelBindings`, and `registeredEvalProfiles`) are **mandatory**. Omitting any evidence category fails closed with `PACK_EVIDENCE_UNAVAILABLE`. If any requirement is unsatisfied, `validatePackCompatibility()` throws a deterministic `CapabilityPackError` before any workflow is activated or executed.

---

## 6. How Do I Resolve and Run a Pack?

In the host application (`@aao/example-capability-packs`), `resolveCompanyCapabilityPacks()` validates the company's pack selection, runs compatibility preflight for each selected pack against the composed `CompanyAAO` instance, and binds each pack directly to its existing company-scoped proof facade:

```ts
import { createCompanyAAO } from "@aao/example-company-portability";
import {
  NORTHSTAR_MANIFEST,
  createTestHostEnvironment,
} from "@aao/example-company-portability/fixtures";
import {
  createStandardPackCatalog,
  resolveCompanyCapabilityPacks,
  NORTHSTAR_PACK_SELECTION,
  NORTHSTAR_RESEARCH_REQUEST,
} from "@aao/example-capability-packs/fixtures";

const env = createTestHostEnvironment();
const catalog = createStandardPackCatalog();

const northstarAAO = createCompanyAAO({
  manifest: NORTHSTAR_MANIFEST,
  hostCapabilities: env.hostCapabilities,
  principalForRun: env.northstarPrincipalForRun,
});

const northstarPacks = resolveCompanyCapabilityPacks({
  company: northstarAAO,
  catalog,
  selection: NORTHSTAR_PACK_SELECTION,
});

const researchPack = northstarPacks.getPack("aao.company-research@1.0.0");
const result = await researchPack.facade.run({
  runId: "run.ns.research.001",
  request: NORTHSTAR_RESEARCH_REQUEST,
});

console.log(result.status); // "completed"
console.log(result.brief.companyName);
```

---

## 7. How Does Human Approval Work for `aao.operational-request@1.0.0`?

The `aao.operational-request@1.0.0` pack declares:
- `outcomeClass: "draft_only"`
- `approval: { required: true, actionClass: "operational_request.write_draft", approverRoles: ["operations_approver"], forbidSelfApproval: true }`

Pack metadata **declares** this requirement for preflight validation, while the canonical **AAO Approval Engine** enforces it at runtime:

1. **Initial execution pauses before tool invocation**:
   ```ts
   const opsFacade = northstarPacks.getPack("aao.operational-request@1.0.0").facade;
   const initial = await opsFacade.execute({
     runId: "run.ns.ops.001",
     request: NORTHSTAR_OPERATIONAL_REQUEST,
   });
   // initial.execution.run.status === "WAITING_FOR_APPROVAL"
   ```
2. **An eligible human approver resolves the approval request**:
   - Self-approval by the requester is forbidden (`SELF_APPROVAL_FORBIDDEN`).
   - Principals without the company's configured approver role are rejected (`APPROVER_NOT_ELIGIBLE`).
   ```ts
   const approvalId = initial.execution.wait.referenceId;
   opsFacade.approvals.approve(approvalId, NORTHSTAR_ACTORS.manager);
   ```
3. **Workflow continuation writes the authorized local draft**:
   ```ts
   const resumed = await opsFacade.continue(initial.execution);
   // resumed.execution.run.status === "COMPLETED"
   ```
   If the approver calls `opsFacade.approvals.reject(...)` instead, continuation fails deterministically with `APPROVAL_REJECTED` and **no draft is written**.

---

## 8. How Do I Run the Pack's Evaluation Profile?

Every Capability Pack references an exact `evalProfileRef` registered in `PackEvalProfileCatalog`. Use `evaluatePackRun()` to run the canonical AAO Evaluation Runtime (`@aao/evaluation`) against the live run trace and execution evidence:

```ts
import {
  evaluatePackRun,
  EVAL_PROFILES,
} from "@aao/example-capability-packs";

const summary = await evaluatePackRun({
  profileRef: EVAL_PROFILES.companyResearch, // "aao.company-research.evals@1.0.0"
  evidenceKey: "run://ns.research.001",
  evidenceMap,
});

console.log(summary.allMatched); // true (5/5 cases passed)
```

---

## 9. How Do I Create a New Pack from an Existing Workflow?

To package an existing deterministic workflow into a Capability Pack:

1. Prepare the canonical workflow plan and read its `id`, `version`, and deterministic `planFingerprint`.
2. Call `defineCapabilityPack()` with a strict `CapabilityPackManifestV1` object:

```ts
import { defineCapabilityPack } from "@aao/capability-packs";

export const CUSTOM_RESEARCH_PACK = defineCapabilityPack({
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
    preliminaryPermissions: ["read_only"],
  },
  execution: {
    outcomeClass: "read_only",
  },
  verification: {
    evalProfileRef: "aao.company-research.evals@1.0.0",
  },
  documentation: {
    summary:
      "Grounded company research using public-web search, deduplication, page fetching, structured synthesis, and deterministic citation validation.",
    limitations: [
      "Read-only public web research only; never writes to external systems.",
    ],
  },
});
```

---

## 10. What Happens When a Pack Version Changes?

- Capability Packs are **immutable** once defined (`Object.isFrozen(pack) === true`).
- If a workflow plan changes (altering its `planFingerprint`), or if required Tools, Model Policies, permissions, or Evaluation profiles change, you must publish a new explicit semantic version (`MAJOR.MINOR.PATCH`).
- Existing companies pinned to `1.0.0` in their `CompanyPackSelectionV1` continue to validate against `1.0.0` until they explicitly update their selection.
- If the underlying workflow code changes without updating the pack's `workflow.planFingerprint`, `validatePackCompatibility()` immediately fails preflight.

---

## 11. What Can a Pack NOT Do?

A Capability Pack **cannot**:
1. Grant permissions, roles, or policy overrides (`grantedPermissions`, `bypassGovernance`, `allowUnapprovedExecution`, etc. are explicitly forbidden).
2. Auto-approve or bypass human Approval gates.
3. Execute arbitrary code, functions, or dynamic module imports from its manifest.
4. Embed credentials, API keys, or live provider endpoints.
5. Bypass `requireCompanyAdmission()` before workflow execution.
6. Perform live external mutations (`outcomeClass` in v1 is restricted to `"read_only"` and `"draft_only"`).

---

## 12. Reference: The Three Initial Flagship Packs

### 12.1 `aao.company-research@1.0.0`

| Attribute | Value |
|---|---|
| **Business Problem** | Produce a structured, citation-backed company research brief from governed public web sources |
| **Workflow Identity** | `company_research.proof@1.0.0` (`d316887874d40e7218ee0dbce3392db29ba8a666b36dcd5d513ebf0a885c2919`) |
| **Tools** | `public_web.search@1.0.0`, `records.dedupe@1.0.0`, `public_web.fetch_pages@1.0.0`, `records.project@1.0.0` |
| **Model Policies** | `company_research.planning`, `company_research.synthesis` (`model.structured_output`) |
| **Integration Requirements** | `public_web` (`publicWebProviderRef`) |
| **Preliminary Permissions** | `["read_only"]` |
| **Approval** | Not required |
| **Outcome Class** | `read_only` |
| **Evaluation Profile** | `aao.company-research.evals@1.0.0` |
| **Non-Goals** | No external system writes, no autonomous open-ended browsing outside governed tools, no ungrounded claims without URL citations |

### 12.2 `aao.document-intelligence@1.0.0`

| Attribute | Value |
|---|---|
| **Business Problem** | Extract structured fields and risk findings from local business documents with exact page and character-span evidence |
| **Workflow Identity** | `document_intelligence.proof@1.0.0` (`ea415041aa2373ed43238e5da162cb8ceebcc6b5603dba20bab7b3dfbf9fd32c`) |
| **Tools** | `document.extract_text@1.0.0` |
| **Model Policies** | `document_intelligence.synthesis` (`model.structured_output`) |
| **Integration Requirements** | `document_source` (`documentSourceProviderRef`) |
| **Preliminary Permissions** | `["read_only"]` |
| **Approval** | Not required |
| **Outcome Class** | `read_only` |
| **Evaluation Profile** | `aao.document-intelligence.evals@1.0.0` |
| **Non-Goals** | No document mutation, no external network access, no claims or extracted fields that do not match exact page/span substrings in the source document |

### 12.3 `aao.operational-request@1.0.0`

| Attribute | Value |
|---|---|
| **Business Problem** | Validate an operational change request, generate a structured change proposal, pause for human Approval, and write an authorized local change draft |
| **Workflow Identity** | `operational_request.proof@1.0.0` (`8323d4dca07e54cb66fa8dd7f0614cf17a2afcd501d39c99802bd0b07c0d9d73`) |
| **Tools** | `operations.create_change_draft@1.0.0` |
| **Model Policies** | `operational_request.interpret` (`model.structured_output`) |
| **Integration Requirements** | `draft_repository` (`draftRepositoryRef`) |
| **Preliminary Permissions** | `["write_draft"]` |
| **Approval** | `{ required: true, requiredRoleIds: ["operations.approver"], permissionClasses: ["write_draft"] }` |
| **Outcome Class** | `draft_only` |
| **Evaluation Profile** | `aao.operational-request.evals@1.0.0` |
| **Non-Goals** | Never executes live mutations against external production systems (`externalExecution: "not_executed"`), never allows self-approval, never writes a draft before explicit human Approval |
