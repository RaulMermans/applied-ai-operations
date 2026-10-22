# Company Configuration & Portability

## Overview

Applied AI Operations (AAO) is built on the principle of **governed business workflows with portable enterprise deployment**. AAO separates invariant workflow definitions from company-specific execution environments, enabling distinct organizations to run the same underlying workflows with their own models, governance policies, integration providers, approval rosters, and state stores without modifying AAO Core or duplicating workflow logic.

## Scope & Architectural Boundary

> **North Star**: Given a validated company configuration and trusted host-supplied capabilities, AAO composes a company-specific execution environment without modifying AAO Core, duplicating workflow implementations, or weakening Governance, Authorization, Approval, Tool Runtime, or Evaluation semantics.

### Boundary Guarantees & Non-Claims

This architecture proves **configuration portability and isolation within a trusted local host**.

It explicitly does **not** claim:
- Adversarial multitenancy or untrusted tenant co-location;
- Distributed multitenant SaaS platforms;
- Production identity federation (SAML 2.0 / OIDC);
- Enterprise secret management vaults;
- Dynamic runtime hot reload or mid-flight configuration switching;
- Distributed approval consensus across networks;
- Production external side-effect execution.

## The Company Manifest V1 Contract (`@aao/config`)

Company configuration is governed by `CompanyManifestV1` in `@aao/config`. The manifest is strictly declarative, schema-validated, versioned, JSON-safe, bounded, deterministic, and free of executable code or credentials.

```ts
interface CompanyManifestV1 {
  schemaVersion: 1;

  companyId: string;
  displayName: string;

  enabledProofs: Array<
    | "company_research"
    | "document_intelligence"
    | "operational_request"
  >;

  models: {
    bindingRefs: string[];
  };

  integrations: {
    publicWebProviderRef?: string;
    documentSourceProviderRef?: string;
    draftRepositoryRef?: string;
  };

  governance: GovernanceConfiguration;

  reliability?: {
    company_research?: Record<string, RuntimeReliabilityPolicy>;
    document_intelligence?: Record<string, RuntimeReliabilityPolicy>;
    operational_request?: Record<string, RuntimeReliabilityPolicy>;
  };
}
```

### Declarative References vs Runtime Objects

A manifest contains strictly declarative references (`"northstar.web-provider"`, `"arbor.model.vercel"`). It never contains function pointers, class instances, or executable code (`ModelAdapter.invoke`, `DocumentSourceProvider.read`, `ApprovalVerifier`).

```text
Company Manifest (Declarative JSON)
       │
       ▼ Exact Capability References
Trusted Host Capability Catalog (Immutable Registry)
       │
       ▼ Concrete Runtime Bindings
Composed Company Execution Environment
```

Dynamic module imports, `eval`, reflection, and package managers are strictly forbidden. The host environment registers trusted capability implementations; the manifest selects authorized capabilities by identifier.

## 12-Step Deterministic Preflight Validation

`validateCompanyManifest(raw)` in `@aao/config` executes a deterministic 12-step validation pipeline before any workflow is composed or executed:

1. **JSON Parsing & Primitive Guard**: Validates that input is valid JSON and parses to a non-null record object.
2. **Prototype Pollution Protection**: Recursively verifies that forbidden keys (`__proto__`, `constructor`, `prototype`) are absent.
3. **Schema Version Check**: Enforces `schemaVersion === 1`. Future or unrecognized versions throw `CONFIG_UNSUPPORTED_VERSION`.
4. **Zod Strict Parsing**: Rejects unknown properties and enforces field bounds.
5. **Company Identity Bounds**: Validates `companyId` slug format and `displayName` bounds.
6. **Proof Reference Uniqueness**: Ensures `enabledProofs` contains no duplicate entries.
7. **Governance Referential Integrity**: Verifies unique principal IDs, defined roles, role bindings, and policies.
8. **Permission Safety**: Enforces that only `read_only` and `write_draft` are assigned; unsupported classes fail closed (`CONFIG_GOVERNANCE_INVALID`).
9. **Model Binding References**: Validates that `models.bindingRefs` is non-empty.
10. **Required Integration References**: Asserts that every enabled proof has its required integration provider reference declared. Operational Request also checks its static requester and approver prerequisites.
11. **Reliability Policy Bounds**: Ensures retry counts and timeout policies are within bounded thresholds.
12. **Snapshot Freezing & Fingerprinting**: Deeply freezes the validated manifest and computes a canonical SHA-256 configuration fingerprint.

## Configuration Fingerprint vs Workflow Plan Fingerprint

AAO enforces a strict separation between workflow identity and configuration identity:

```text
Same Workflow Definition
        +
Different Company Configurations (Northstar vs Arbor)
        =
Identical Workflow Plan Fingerprint
Distinct Company Configuration Fingerprints
```

- **Workflow Plan Fingerprint**: Identifies the compiled DAG topology, node IDs, dependencies, and deterministic executor logic (`proof.planFingerprint`). It is invariant across companies.
- **Company Configuration Fingerprint**: SHA-256 digest of the canonical JSON serialization of the validated manifest snapshot (`validateCompanyManifest(m).configFingerprint`). It changes if and only if configuration changes.

## Host Capability Catalog

The host catalog (`createHostCapabilityCatalog`) provides an immutable lookup interface for host-supplied capabilities:
- Model Adapters (`ModelAdapterDefinition`)
- Model Bindings (`ModelBindingDefinition`)
- Public-Web Providers (`PublicWebProvider`)
- Document-Source Providers (`DocumentSourceProvider`)
- Draft Repositories (`OperationalDraftRepository`)

Registration entries are copied into private maps. Consumers receive exact-reference lookup methods, never live maps or mutable entry collections. `set`, `delete`, and `clear` cannot alter bindings after construction. Provider objects themselves remain host-owned and may keep state; only catalog bindings and validated manifest snapshots are immutable.

For Operational Request, preflight requires a registered requester with active `write_draft` authority after applicable deny policies, and a different registered human with an active `operations.approver` binding. `read_only` does not qualify a requester, and `write_draft` does not qualify an approver. This is a static coherence check. Runtime Governance and Authorization still check the actual host-attested requester, and the Approval Engine still checks the actual human and no-self-approval rule for each request.

Any reference in a company manifest that is not found in the catalog immediately throws `CONFIG_CAPABILITY_NOT_FOUND` at composition time, failing closed before execution.

## Company AAO Composition (`createCompanyAAO`)

The composition factory `createCompanyAAO` builds a company execution container:
1. Validates the manifest and freezes the configuration snapshot.
2. Resolves model bindings and adapters, asserting compatibility (`model.structured_output`).
3. Instantiates enabled proofs passing company-scoped governance, providers, and bindings.
4. Isolates Tool Registries, Governance subjects, and Approval engines to the specific company scope.
5. Guarantees immutable configuration during a run: no hot reload, no mid-flight tenant switching.

## Deterministic Host-Side Admission Gate (`requireCompanyAdmission`)

In workflows where model reasoning precedes governed Tool nodes (such as Company Research's `plan` node), relying solely on Tool Runtime authorization allows an unauthorized principal to trigger model execution before Tool authorization eventually fails.

To enforce deterministic, company-scoped isolation, AAO introduces a host-side admission gate before any Workflow execution begins:

```text
Company Execution Request
           │
           ▼
  Trusted Company Host
           │
           ▼
 Resolve Host-Attested Principal
           │
           ▼
 Canonical Governance Decision (resolveAuthority)
           │
       ┌───┴───┐
       ▼       ▼
     DENY    ALLOW
       │       │
       ▼       ▼
   No Run   Existing Workflow
   No Model      │
   No Tool       ▼
   No Provider  Existing AAO Runtime
                 │
                 ▼
          Model / Tool / Approval
          Existing Authority Gates
```

### The Three Boundaries

AAO maintains three distinct, non-interchangeable security boundaries:

- **Admission** determines whether a Run may start. Backed by canonical Governance (`resolveAuthority` from `@aao/governance`), it validates host-attested principal eligibility against fixed preliminary proof permissions before model invocation, tool invocation, provider access, approval creation, draft creation, or workflow run execution.
- **Authorization** determines whether a Tool may execute. Enforced deterministically by the Tool Runtime at tool invocation time against the principal's effective permissions.
- **Approval** determines whether an eligible human has authorized a specific business proposal. Enforced by the canonical Approval Engine.

### Fixed Preliminary Permissions

Preliminary permissions are owned by trusted application code and cannot be overridden by request input, model output, or manifests:

| Proof | Required Preliminary Permission | Rationale |
|---|---|---|
| `company_research` | `read_only` | Entry into public-web search and synthesis workflows |
| `document_intelligence` | `read_only` | Entry into document extraction and grounding workflows |
| `operational_request` | `write_draft` | Entry into business proposal and draft staging workflows |

### Zero Side-Effect Invariant on Denial

When an unauthorized principal is denied admission:
- Model invocations = 0
- Tool invocations = 0
- Provider calls = 0
- Approval records created = 0
- Drafts created = 0
- Workflow runs started = 0

The request fails closed with a typed `CompanyAdmissionError` (`code: "COMPANY_ADMISSION_DENIED"`). No synthetic runtime traces or fake workflow executions are fabricated.

## Guarded Proof Facades & Elimination of Execution Bypasses

To prevent callers from bypassing admission checks through alternative API surfaces:

1. **Guarded Facade Interfaces**: `createCompanyAAO` returns guarded facade objects (`CompanyResearchFacade`, `DocumentIntelligenceFacade`, `OperationalRequestFacade`). Every entry point (`runCompanyResearch`, `runDocumentIntelligence`, `executeOperationalRequest`, `continueOperationalRequest`, `proof.run`, `proof.execute`, `proof.continue`) enforces `requireCompanyAdmission()`.
2. **Omission of Raw Engine Objects**: Raw `app` instances (`AAOApplication`), `approvalVerifier`, and `draftRepository` are deliberately omitted from public facade properties. Callers cannot invoke `app.prepareWorkflow().execute(...)` or `approvalVerifier.verify(...)` directly to bypass the company admission gate.
3. **Continuation Guard**: Continuation of pending workflows (e.g. `continueOperationalRequest`) enforces admission with the continued `runId`, ensuring revoked authority prevents workflow resumption before any node execution.
