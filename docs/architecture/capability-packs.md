# Capability Packs Architecture Specification

## 1. Purpose

A **Capability Pack** is a versioned, reusable, declarative contract that describes an established Applied AI Operations (AAO) business capability. It specifies the exact workflow definition, required Tools, required Model Policies, required integration slots, preliminary permission requirements, human approval requirements, execution outcome class, and evaluation verification profile.

Capability Packs allow an application or enterprise to select, validate, and activate proven AAO workflows without copying workflow graphs, creating new execution engines, or weakening Governance.

## 2. Capability Pack Manifest V1

All Capability Packs conform to `CapabilityPackManifestV1` (`schemaVersion: 1`):

```ts
interface CapabilityPackManifestV1 {
  schemaVersion: 1;
  id: string;
  version: string; // Exact SemVer: MAJOR.MINOR.PATCH
  name: string;
  description: string;
  category: string;
  tags: string[];
  workflow: {
    id: string;
    version: string;
    planFingerprint: string; // 64-char SHA-256 hex
  };
  requirements: {
    toolRefs: Array<{ id: string; version: string }>;
    modelPolicyRefs: string[];
    modelCapabilities: string[];
    integrationSlots: Array<{ slot: string; description: string }>;
    preliminaryPermissions: Array<"read_only" | "write_draft">;
    approval?: {
      required: boolean;
      requiredRoleIds: string[];
      permissionClasses: Array<"read_only" | "write_draft">;
    };
  };
  execution: {
    outcomeClass: "read_only" | "draft_only";
  };
  verification: {
    evalProfileRef: string; // evalId@MAJOR.MINOR.PATCH
  };
  documentation: {
    summary: string;
    limitations: string[];
  };
}
```

### Hard Invariants
- **Strict Schema**: Unknown properties are rejected.
- **No Arbitrary Behavior**: Fields such as `handler`, `execute`, `script`, `modulePath`, `dynamicImport`, `eval`, `skipAuthorization`, `disableApproval`, `forceSuccess`, and `allowExternalEffects` are rejected with `PACK_INVALID_MANIFEST`.
- **No Prototype Pollution**: Keys `__proto__`, `constructor`, and `prototype` are rejected at any depth.
- **Exact Versions Only**: Version ranges (`^1.0.0`, `>=1.0`), tags (`latest`), and wildcards are rejected.
- **Supported Permissions Only**: Only `read_only` and `write_draft` are admissible in V1; `external_side_effect`, `destructive`, and `sensitive_data` fail closed.
- **Outcome Class Coherence**: `read_only` packs cannot require approval or declare `write_draft`; `draft_only` packs must declare `write_draft`.

## 3. Identity & Fingerprinting

Canonical Pack identity is formatted as `packId@MAJOR.MINOR.PATCH` (e.g., `aao.company-research@1.0.0`).

A Pack's `fingerprint` is the 64-character lowercase SHA-256 hex digest of `canonicalJsonStringify(manifest)`.

| Identity Concept | Scope |
|---|---|
| `workflow.planFingerprint` | Compiled executable workflow plan |
| `pack.fingerprint` | Declarative pack manifest and dependency metadata |
| `company.configFingerprint` | Validated `CompanyManifestV1` configuration |
| `runId` | Individual runtime execution instance |

## 4. Public API (`@aao/capability-packs`)

- `defineCapabilityPack(manifestInput)`: Validates a manifest, computes its deterministic SHA-256 fingerprint, and returns a deep-frozen `CapabilityPack`.
- `createCapabilityPackCatalog(packs)`: Constructs an immutable catalog backed by a private map and defensive copying.
  - `listCapabilityPacks()`: Returns all packs sorted deterministically by identity.
  - `getCapabilityPack(ref)`: Resolves a pack by `{ id, version }` or `"id@version"`.
  - `describeCapabilityPack(ref)`: Returns a descriptive snapshot or throws `PACK_NOT_FOUND`.
  - `searchCapabilityPacks(query)`: Deterministic case-insensitive lexical search across id, name, description, category, and tags.
- `validateCompanyPackSelection(raw)`: Validates `CompanyPackSelectionV1` (`{ schemaVersion: 1, companyId, packRefs }`).
- `validatePackCompatibility(pack, context)`: Performs preflight compatibility verification before any Run begins.

## 5. Compatibility Validation, Registration Evidence & Failure Taxonomy

### 5.1 Trusted Registration Snapshot (`ProofRegistrationSnapshot`)
At proof construction (`createAAO()`), each proof captures a deep-frozen, read-only `ProofRegistrationSnapshot` derived from the actual objects registered with the runtime:

```ts
interface ProofRegistrationSnapshot {
  readonly workflow: {
    readonly id: string;
    readonly version: string;
    readonly planFingerprint: string;
  };
  readonly tools: readonly ExactToolRef[];
  readonly modelPolicies: readonly string[];
  readonly modelBindings: readonly VerifiedModelBinding[];
  readonly modelAdapters: readonly VerifiedModelAdapter[];
}
```

This boundary exposes only immutable identity and capability metadata—never `app`, `prepareWorkflow`, Tool handlers, Model Adapter implementations, or Approval verifiers. Static fallback inventories (`STANDARD_PROOF_TOOLS`, `STANDARD_MODEL_POLICIES`) are prohibited.

### 5.2 Mandatory Compatibility Evidence
`PackCompatibilityContext` requires explicit registration evidence for every dependency category:
- `registeredTools`: `readonly ExactToolRef[]`
- `registeredModelPolicies`: `readonly string[]`
- `registeredModelBindings`: `readonly VerifiedModelBinding[]`
- `registeredModelAdapters`: `readonly VerifiedModelAdapter[]` (or `adapterCapabilities` paired on each binding)
- `registeredEvalProfiles`: `readonly string[]`

Omitted, `undefined`, `null`, or malformed evidence arrays fail closed with `PACK_EVIDENCE_UNAVAILABLE`. Duplicate or conflicting registrations fail closed with `PACK_CAPABILITY_INCOMPATIBLE`.

### 5.3 Binding + Adapter Capability Verification
For every capability in `pack.manifest.requirements.modelCapabilities` (such as `model.structured_output`), preflight verifies that:
1. At least one registered `ModelBindingDefinition` declares the capability in `binding.capabilities`;
2. That binding's exact `adapterRef` (`id@version`) resolves to a registered `ModelAdapterDefinition`; and
3. That adapter's `manifest.capabilities` also includes the required capability.

### 5.4 Eval Profile Registration & Verification
`PackEvalProfileCatalog` (`createPackEvalProfileCatalog`, `createStandardEvalProfileCatalog`) registers exact `evalId@MAJOR.MINOR.PATCH` profiles and runs `verifyEvalProfileRegistration()` at catalog construction time to confirm that:
- The profile reference matches `ExactEvalProfileRefSchema`;
- The suite builder produces a valid `EvalDatasetContract` and `EvalDefinitionContract` with supported mode (`offline_fixture` or `trace_replay`); and
- Every referenced grader is registered in the canonical `EvaluatorRegistry`.

During pack compatibility preflight, `pack.manifest.verification.evalProfileRef` must exist in `registeredEvalProfiles`, or validation fails closed with `PACK_VERIFICATION_PROFILE_MISSING` (without executing the Eval dataset during activation).

### 5.5 Atomic Whole-Selection Validation
`resolveCompanyCapabilityPacks()` validates all packs in `CompanyPackSelectionV1` before activating any facade. If even one selected pack fails compatibility, the entire selection is refused and zero packs are activated.

### 5.6 Preflight Checklist
Before a selected pack is exposed for execution, preflight validation checks:
1. Mandatory registration evidence is present and well-formed (`PACK_EVIDENCE_UNAVAILABLE`).
2. Workflow identity, version, and prepared `planFingerprint` match the pack manifest (`PACK_WORKFLOW_MISMATCH` / `PACK_CAPABILITY_INCOMPATIBLE`).
3. Underlying proof is enabled in the company's `enabledProofs` (`PACK_PROOF_DISABLED`).
4. Required Tool definitions (`id@version`) are present in `registeredTools` (`PACK_REQUIREMENT_MISSING`).
5. Required Model Policies are present in `registeredModelPolicies` (`PACK_REQUIREMENT_MISSING`).
6. Required Model Capabilities are supported by a valid registered binding + adapter pair (`PACK_CAPABILITY_INCOMPATIBLE`).
7. Required Integration Slots (`publicWebProviderRef`, `documentSourceRef`, `draftRepositoryRef`) are bound (`PACK_REQUIREMENT_MISSING`).
8. Required Governance permissions and approver roles exist (`PACK_REQUIREMENT_MISSING` / `PACK_GOVERNANCE_INCOMPATIBLE`).
9. Required `evalProfileRef` is present in `registeredEvalProfiles` (`PACK_VERIFICATION_PROFILE_MISSING`).

### Error Codes (`CapabilityPackErrorCode`)
- `PACK_INVALID_MANIFEST`
- `PACK_UNSUPPORTED_VERSION`
- `PACK_DUPLICATE_REF`
- `PACK_NOT_FOUND`
- `PACK_WORKFLOW_MISMATCH`
- `PACK_EVIDENCE_UNAVAILABLE`
- `PACK_REQUIREMENT_MISSING`
- `PACK_CAPABILITY_INCOMPATIBLE`
- `PACK_PROOF_DISABLED`
- `PACK_GOVERNANCE_INCOMPATIBLE`
- `PACK_VERIFICATION_PROFILE_MISSING`
- `PACK_SCOPE_MISMATCH`

## 6. Authority & Trust Boundary

Capability Pack metadata is **descriptive, never authoritative**:
- Pack selection does not install software, download plugins, or execute arbitrary code.
- Pack compatibility resolution confirms that a company has configured and registered the necessary capabilities; it does not authorize any principal.
- Execution through an activated pack facade (`ActivatedCompanyPack.facade`) always enforces `requireCompanyAdmission()`, canonical Governance evaluation, Tool Runtime Authorization, and the Approval Engine.

## 7. Initial Flagship Capability Packs

### 7.1 `aao.company-research@1.0.0`
- **Workflow**: `company_research.proof@1.0.0` (`planFingerprint: d316887874d40e7218ee0dbce3392db29ba8a666b36dcd5d513ebf0a885c2919`)
- **Tools**: `public_web.search@1.0.0`, `records.dedupe@1.0.0`, `public_web.fetch_pages@1.0.0`, `records.project@1.0.0`
- **Model Policies**: `company_research.planning`, `company_research.synthesis` (`model.structured_output`)
- **Integration Slot**: `public_web` (`publicWebProviderRef`)
- **Permissions & Approval**: `read_only`, no human approval required, outcome class `read_only`
- **Eval Profile**: `aao.company-research.evals@1.0.0`

### 7.2 `aao.document-intelligence@1.0.0`
- **Workflow**: `document_intelligence.proof@1.0.0` (`planFingerprint: ea415041aa2373ed43238e5da162cb8ceebcc6b5603dba20bab7b3dfbf9fd32c`)
- **Tools**: `document.extract_text@1.0.0`
- **Model Policies**: `document_intelligence.synthesis` (`model.structured_output`)
- **Integration Slot**: `document_source` (`documentSourceProviderRef`)
- **Permissions & Approval**: `read_only`, no human approval required, outcome class `read_only`
- **Eval Profile**: `aao.document-intelligence.evals@1.0.0`

### 7.3 `aao.operational-request@1.0.0`
- **Workflow**: `operational_request.proof@1.0.0` (`planFingerprint: 8323d4dca07e54cb66fa8dd7f0614cf17a2afcd501d39c99802bd0b07c0d9d73`)
- **Tools**: `operations.create_change_draft@1.0.0`
- **Model Policies**: `operational_request.interpret` (`model.structured_output`)
- **Integration Slot**: `draft_repository` (`draftRepositoryRef`)
- **Permissions & Approval**: `write_draft`, human approval required (`requiredRoleIds: ["operations.approver"]`), outcome class `draft_only`
- **Eval Profile**: `aao.operational-request.evals@1.0.0`
