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

Before activating or running any pack, run `validatePackCompatibility(pack, context)` to verify that the company configuration and host environment satisfy every requirement declared by the pack:

```ts
import {
  OPERATIONAL_REQUEST_PACK,
  validatePackCompatibility,
} from "@aao/capability-packs";
import { buildOperationalRequestWorkflowPlan } from "@aao/example-operational-request";

const workflowPlan = buildOperationalRequestWorkflowPlan();

const report = validatePackCompatibility(OPERATIONAL_REQUEST_PACK, {
  companyId: "northstar-commerce",
  enabledProofs: ["company_research", "document_intelligence", "operational_request"],
  governanceRoles: [
    {
      roleId: "requester",
      permissions: ["read_only", "write_draft"],
      canApprove: false,
    },
    {
      roleId: "operations_approver",
      permissions: ["read_only", "write_draft", "approve_requests"],
      canApprove: true,
    },
  ],
  modelBindings: [
    {
      id: "northstar-structured",
      capabilities: ["model.structured_output"],
    },
  ],
  integrations: {
    draftRepositoryRef: "repo.northstar.drafts",
  },
  workflow: {
    id: workflowPlan.id,
    version: workflowPlan.version,
    planFingerprint: workflowPlan.planFingerprint,
  },
  availableTools: [{ id: "draft.change_request.write", version: "1.0.0" }],
  availableModelPolicies: [{ id: "operational_request.proposal.default", version: "1.0.0" }],
  availableEvalProfiles: ["eval.operational_request.default@1.0.0"],
});

console.log(report.compatible); // true
```

If any check fails, `validatePackCompatibility()` throws a deterministic `CapabilityPackError` before any workflow is composed or executed.

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

Every Capability Pack references an exact `evalProfileRef`. Use `evaluatePackRun()` to run the canonical AAO Evaluation Runner (`@aao/evals`) against the live run trace and output:

```ts
import { evaluatePackRun } from "@aao/example-capability-packs";

const summary = await evaluatePackRun({
  pack: researchPack.pack,
  caseId: "eval.ns.company_research",
  runEvidenceRef: "run://ns.research.001",
  output: result.brief,
  evidenceResolver: {
    resolve(ref) {
      return evidenceMap.get(ref);
    },
  },
});

console.log(summary.passed); // true (passRate === 1)
```

---

## 9. How Do I Create a New Pack from an Existing Workflow?

To package an existing deterministic workflow into a Capability Pack:

1. Build the canonical workflow plan and read its `id`, `version`, and deterministic `planFingerprint`.
2. Call `defineCapabilityPack()` with a strict `CapabilityPackManifestV1` object:

```ts
import { defineCapabilityPack } from "@aao/capability-packs";
import { buildCompanyResearchWorkflowPlan } from "@aao/example-company-research";

const plan = buildCompanyResearchWorkflowPlan();

export const CUSTOM_RESEARCH_PACK = defineCapabilityPack({
  schemaVersion: 1,
  id: "aao.company-research",
  version: "1.0.0",
  name: "AAO Company Research Pack",
  description:
    "Produces a structured, citation-backed company research brief from governed public web pages.",
  category: "research",
  tags: ["company-research", "citations", "public-web", "read-only"],
  workflow: {
    id: plan.id,
    version: plan.version,
    planFingerprint: plan.planFingerprint,
  },
  requirements: {
    toolRefs: [
      { id: "web.search", version: "1.0.0" },
      { id: "web.fetch_page", version: "1.0.0" },
      { id: "text.extract_sections", version: "1.0.0" },
    ],
    modelPolicyRefs: [{ id: "company_research.brief.default", version: "1.0.0" }],
    modelCapabilities: ["model.structured_output"],
    integrationSlots: [
      {
        slot: "publicWebProviderRef",
        kind: "public_web_provider",
        required: true,
        description: "Company-bound public web search and page fetch provider.",
      },
    ],
    preliminaryPermissions: ["read_only"],
    approval: {
      required: false,
    },
  },
  contracts: {
    inputContractId: "aao.company-research.request@1.0.0",
    outputContractId: "aao.company-research.brief@1.0.0",
  },
  execution: {
    outcomeClass: "read_only",
  },
  verification: {
    evalProfileRef: "eval.company_research.default@1.0.0",
  },
  documentation: {
    summary:
      "Executes the canonical 5-step Company Research workflow over governed public web tools.",
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
- If the underlying workflow code changes without updating the pack's `workflow.planFingerprint`, `validatePackCompatibility()` immediately fails preflight with `PACK_WORKFLOW_MISMATCH`.

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
| **Tools** | `web.search@1.0.0`, `web.fetch_page@1.0.0`, `text.extract_sections@1.0.0` |
| **Model Policy** | `company_research.brief.default@1.0.0` (`model.structured_output`) |
| **Integration Requirements** | `publicWebProviderRef` (`public_web_provider`, required) |
| **Preliminary Permissions** | `["read_only"]` |
| **Approval** | `{ required: false }` |
| **Input / Output Contracts** | `aao.company-research.request@1.0.0` -> `aao.company-research.brief@1.0.0` |
| **Outcome Class** | `read_only` |
| **Evaluation Profile** | `eval.company_research.default@1.0.0` |
| **Non-Goals** | No external system writes, no autonomous open-ended browsing outside governed `web.search` / `web.fetch_page` tools, no ungrounded claims without URL citations |

### 12.2 `aao.document-intelligence@1.0.0`

| Attribute | Value |
|---|---|
| **Business Problem** | Extract structured fields and risk findings from local business documents with exact page and character-span evidence |
| **Workflow Identity** | `document_intelligence.proof@1.0.0` (`ea415041aa2373ed43238e5da162cb8ceebcc6b5603dba20bab7b3dfbf9fd32c`) |
| **Tools** | `document.load@1.0.0`, `document.extract_text@1.0.0`, `text.extract_sections@1.0.0` |
| **Model Policy** | `document_intelligence.analysis.default@1.0.0` (`model.structured_output`) |
| **Integration Requirements** | `documentSourceRef` (`document_source`, required) |
| **Preliminary Permissions** | `["read_only"]` |
| **Approval** | `{ required: false }` |
| **Input / Output Contracts** | `aao.document-intelligence.request@1.0.0` -> `aao.document-intelligence.report@1.0.0` |
| **Outcome Class** | `read_only` |
| **Evaluation Profile** | `eval.document_intelligence.default@1.0.0` |
| **Non-Goals** | No document mutation, no external network access, no claims or extracted fields that do not match exact page/span substrings in the source document |

### 12.3 `aao.operational-request@1.0.0`

| Attribute | Value |
|---|---|
| **Business Problem** | Validate an operational change request, generate a structured change proposal, pause for human Approval, and write an authorized local change draft |
| **Workflow Identity** | `operational_request.proof@1.0.0` (`8323d4dca07e54cb66fa8dd7f0614cf17a2afcd501d39c99802bd0b07c0d9d73`) |
| **Tools** | `draft.change_request.write@1.0.0` |
| **Model Policy** | `operational_request.proposal.default@1.0.0` (`model.structured_output`) |
| **Integration Requirements** | `draftRepositoryRef` (`draft_repository`, required) |
| **Preliminary Permissions** | `["read_only", "write_draft"]` |
| **Approval** | `{ required: true, actionClass: "operational_request.write_draft", approverRoles: ["operations_approver"], forbidSelfApproval: true }` |
| **Input / Output Contracts** | `aao.operational-request.request@1.0.0` -> `aao.operational-request.result@1.0.0` |
| **Outcome Class** | `draft_only` |
| **Evaluation Profile** | `eval.operational_request.default@1.0.0` |
| **Non-Goals** | Never executes live mutations against external production systems (`externalExecution: "not_executed"`), never allows self-approval, never writes a draft before explicit human Approval |
