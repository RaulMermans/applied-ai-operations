# ADR-030: Company Configuration & Portability: Multi-Company Composition Without Core Forks

Status: accepted (Sprint 25)

## Context

Sprints 22, 23, and 24 delivered the three foundational flagship workflows of Applied AI Operations (AAO):
- **Sprint 22 (Company Research)**: Governed public-web research, tool orchestration, rate-limited fetching, and structured synthesis (`company_research.proof@1.0.0`).
- **Sprint 23 (Document Intelligence)**: Governed document ingestion, isolated worker segmentation, deterministic span indexing, and citation-grounded analysis (`document_intelligence.proof@1.0.0`).
- **Sprint 24 (Operational Request)**: Governed business intake, bounded model interpretation, deterministic action proposal validation, human approval waitpoints, and safe draft creation (`operational_request.proof@1.0.0`).

Sprint 25 addresses the architectural challenge at the core of AAO's mission: **proving the reusable enterprise deployment thesis**. Can these three flagship workflows be configured and operated for two independent companies using the exact same underlying implementations, without modifying AAO Core, duplicating workflow definitions, or weakening Governance, Authorization, Approval, Tool Runtime, or Evaluation semantics?

### Product & Security Boundary

AAO is designed to be deployable across distinct enterprises. This sprint explicitly addresses **configuration portability and composition within a trusted host**. It explicitly does **not** claim:
- Adversarial multitenancy or untrusted tenant co-location;
- Distributed multitenant SaaS infrastructure;
- Production identity federation (SAML/OIDC);
- Enterprise secrets management vaults;
- Dynamic runtime hot reload or mid-flight configuration mutation;
- Distributed approval transactions across organizations;
- Production external side-effect execution.

## Decision

### 1. Deterministic Configuration and Composition Workflow, Not a New Agent

We reject creating an orchestration agent, dynamic plugin framework, or capability pack abstraction. Multi-company composition is a deterministic, host-governed software lifecycle operation:

```text
             AAO Core
                |
       Existing Framework
                |
       Company Configuration
                |
        Strict Validation
                |
       Capability Resolution
                |
       Company Composition
                |
       +--------+--------+
       |                 |
       v                 v
    Company A         Company B
       |                 |
       v                 v
   Same Workflow     Same Workflow
   Definitions       Definitions
       |                 |
       v                 v
   Own Models        Own Models
   Own Governance    Own Governance
   Own Providers     Own Providers
   Own State         Own State
   Own Approvals     Own Approvals
       |                 |
       v                 v
   Isolated Runs     Isolated Runs
```

### 2. Company Manifest V1 Contract (`@aao/config`)

We extend `@aao/config` with a strict, versioned, declarative configuration contract (`CompanyManifestV1`):
- `schemaVersion: 1`: Strict versioning. Unknown schema versions fail closed; no silent reinterpretation or implicit migration.
- `companyId`: Validated identifier matching `/^[a-z0-9][a-z0-9-_]{0,62}[a-z0-9]$/`.
- `displayName`: Bounded human-readable name (1-120 chars).
- `enabledProofs`: Array of enabled proof identifiers (`company_research`, `document_intelligence`, `operational_request`). Proofs not explicitly enabled fail fast on invocation (`CONFIG_PROOF_DISABLED`).
- `models.bindingRefs`: Explicit string references to model bindings registered in the host catalog.
- `integrations`: Explicit string references to host integration providers (`publicWebProviderRef`, `documentSourceProviderRef`, `draftRepositoryRef`).
- `governance`: Full `GovernanceConfiguration` defining principals, roles, role bindings, and policies.
- `reliability`: Bounded, optional per-proof reliability overrides.

The manifest is JSON-safe, bounded, deterministic, and free of executable code, dynamic imports, class references, or embedded credentials.

### 3. Separation of Declarative Data From Runtime Objects

Company manifests contain declarative capability references (e.g., `"northstar.web-provider"`, `"arbor.model.vercel"`). They never serialize or define runtime objects (`ModelAdapter.invoke`, `DocumentSourceProvider.read`, `ApprovalVerifier`, etc.).

All concrete runtime objects reside in an immutable, host-owned **Host Capability Catalog** (`createHostCapabilityCatalog`). The manifest selects only from capabilities the host operator has explicitly authorized and registered. Attempts to reference unregistered capabilities throw `CONFIG_CAPABILITY_NOT_FOUND` before any workflow execution begins.

The catalog defensively copies registration entries into private maps and exposes only exact-reference lookup methods. Freezing a JavaScript `Map` object does not freeze its entries; the earlier exposed `ReadonlyMap` properties allowed runtime `set`, `delete`, and `clear`. Duplicate references are rejected at construction. Binding identity is fixed after construction, including for companies composed later. Capability instances remain host-owned and may maintain operational state; they are not deep-frozen. This differs from the separately deep-frozen validated manifest snapshot.

### 4. Deterministic Preflight Validation & Configuration Fingerprinting

`validateCompanyManifest` executes a 12-step deterministic preflight sequence:
1. JSON parsing and primitive guard.
2. Prototype pollution key rejection (`__proto__`, `constructor`, `prototype`).
3. Schema version verification (strictly 1).
4. Zod strict schema parsing (unknown keys rejected).
5. Company identity validation.
6. Proof reference uniqueness check.
7. Governance referential integrity (unique IDs, defined subjects and roles).
8. Permission class safety (only canonical permissions like `read_only`, `write_draft` permitted).
9. Model binding references coherence.
10. Required integration references for all enabled proofs.
11. Reliability policy bounds validation.
12. Deep freezing of the snapshot and SHA-256 fingerprint computation using canonical JSON serialization.

When Operational Request is enabled, preflight additionally requires a registered principal with an active role granting `write_draft` and no applicable canonical deny rule, plus a distinct registered `user` with an active `operations.approver` binding. The approver's action permissions are irrelevant to approval eligibility. The canonical Approval Engine still checks role membership, human type, and self-approval for each decision; Runtime Governance and Authorization still decide each Tool use. Preflight cannot attest that the host will supply a particular requester at run time or that live authority will remain unchanged.

### 5. Architectural Distinction: Configuration Fingerprint vs Workflow Plan Fingerprint

We establish a fundamental identity boundary:
- **Workflow Plan Fingerprint**: Identifies the immutable workflow structure, DAG nodes, dependencies, and deterministic executor logic. It is identical across all companies executing the same workflow proof.
- **Company Configuration Fingerprint**: Identifies the tenant-specific configuration snapshot (models, bindings, providers, governance, and permissions). It is unique to each company configuration.

```text
Same Workflow Proof
    +
Different Company Configurations (Northstar vs Arbor)
    =
Identical Workflow Plan Fingerprint
Distinct Company Configuration Fingerprints
```

### 6. Company AAO Composition (`createCompanyAAO`)

The composition factory `createCompanyAAO` accepts a validated manifest and a host capability catalog, constructing a company-scoped execution container:
- Validates the manifest and freezes its configuration snapshot at construction time (no hot reload, no mid-run tenant switching).
- Resolves exact capabilities from the host catalog; rejects incompatible model adapters lacking `model.structured_output`.
- Composes the three flagship proofs (`CompanyResearchProof`, `DocumentIntelligenceProof`, `OperationalRequestProof`) passing company-specific governance, model bindings, and providers.
- Isolates Tool Registries, Governance verification, and Approval verifiers strictly to the composed company scope.
- Enforces fail-closed isolation: cross-company principals, approval records, or document IDs are rejected.

### 7. Deterministic Pre-Execution Company Admission & Guarded Proof Facades (Sprint 25D)

In Sprint 25C, the cross-company isolation test proved that foreign principals are correctly rejected by canonical Tool Authorization at the first governed Tool boundary (`TOOL_AUTHORIZATION_REQUIRED`). However, because Company Research executes its planning model (`plan`) before reaching its first Tool (`search`), foreign principals could cause an unauthorized model invocation before Tool Runtime rejected the run.

#### Rejection of Workflow Graph Reordering

We explicitly reject modifying or reordering Workflow DAG nodes to solve this issue (e.g., placing `search` before `plan`, adding an artificial dummy tool before planning, or conditional routing). Such alterations would distort natural workflow semantics, fork workflow graphs across use cases, and violate the core portability invariant:
```text
PlanFingerprint(Northstar) === PlanFingerprint(Arbor)
```

#### Deterministic Host-Side Admission Architecture

Instead, we introduce deterministic host-side admission backed by canonical AAO Governance (`@aao/governance`):

```text
Company Execution Request
           │
           ▼
  Trusted Company Host
           │
           ▼
 Resolve Host-Attested Principal (principalForRun)
           │
           ▼
 Canonical Governance Decision (resolveAuthority)
           │
       ┌───┴───┐
       │       │
      DENY   ALLOW
       │       │
       ▼       ▼
    No Run  Existing Workflow
   No Model     │
   No Tool      ▼
 No Provider Existing AAO Runtime
                │
                ▼
         Model / Tool / Approval
         Existing Authority Gates
```

#### Core Invariants & Rules

1. **Canonical Governance Reuse**: The admission gate calls `resolveAuthority(governanceRegistry, principal, requiredPermissions)` directly against the validated, immutable Governance snapshot compiled at composition time (`createGovernanceRegistry(manifest.governance)`). No custom policy evaluator, permission class, or interpreter is introduced.
2. **Fixed Application-Owned Admission Permissions**: Preliminary requirements are fixed constants defined in trusted application code:
   - `company_research`: `read_only`
   - `document_intelligence`: `read_only`
   - `operational_request`: `write_draft`
   These requirements cannot be altered by request payloads, model proposals, company display names, manifest extensions, or dynamic expressions.
3. **Boundary Distinction**: Admission determines whether a Run may start; Tool Runtime Authorization determines whether a specific Tool may execute; Human Approval determines whether an authorized human has approved a concrete proposal. None replaces the others.
4. **Trusted Principal & Run ID Separation**: `principalForRun({ runId })` is a trusted host function. Run IDs are correlation identifiers, never authentication credentials. Authorization is never derived from string prefixes or request parameters.
5. **Guarded Proof Facades**: Raw proof instances are kept private inside `createCompanyAAO()`. Getters (`getCompanyResearchProof()`, `getDocumentIntelligenceProof()`, `getOperationalRequestProof()`) return narrow facades enforcing admission on `.run()`, `.execute()`, and `.continue()`. Implementation objects (`app`, `approvalVerifier`, `draftRepository`) that could allow alternative `app.prepareWorkflow()` bypass paths are excluded from public facades.
6. **Operational Continuation Protection**: Continuation paths (`continueOperationalRequest` and `facade.continue`) re-enforce admission using the canonical Run ID association before resuming execution, preventing cross-company continuation while preserving canonical human approval checks.
7. **Admission Failure Semantics & Zero-Call Invariant**: Denied attempts throw `CompanyAdmissionError` with code `COMPANY_ADMISSION_DENIED` and Governance reason codes (`GOVERNANCE_DEFAULT_DENY`, `GOVERNANCE_POLICY_DENY`). On denial, exactly 0 model calls, 0 tool calls, 0 provider calls, 0 approval records, and 0 drafts occur. No Workflow run starts and no execution trace is fabricated.
8. **Local Trusted Host Boundary**: The architecture guarantees strict isolation within a trusted host process and does not claim adversarial multitenancy, network isolation, or identity federation.

## Consequences

### Positive
- **Proven Portability**: The 3 flagship workflows run against Northstar Commerce (retail inventory sync, native model adapter, supplier agreements, merchandise approval) and Arbor Consulting (management advisory, Vercel AI SDK mock model, client MSA, client display name approval) without altering workflow code.
- **Zero Core Forks**: AAO Core (`@aao/framework`, `@aao/runtime`, `@aao/tool-runtime`, `@aao/governance`, `@aao/approval`) remains untouched.
- **Pre-Execution Admission & Fail-Closed Isolation**: Cross-company principal invocations fail closed with `COMPANY_ADMISSION_DENIED` before any model, tool, or provider execution; cross-company approvals are rejected; overlapping document refs resolve strictly within company provider bounds.
- **Compiled admission evidence**: The cross-company smoke submits a schema-valid Research request with a Northstar principal to Arbor, proves `COMPANY_ADMISSION_DENIED` with exactly zero model calls, zero provider calls, and zero workflow executions, then runs the same request with an authorized Arbor principal as a positive control.
- **Verifiable Identity**: Plan fingerprints prove shared compilation; configuration fingerprints prove distinct governed environments.

### Trade-offs & Limitations
- Composition is immutable at construction time; updating a company configuration requires instantiating a new composition.
- Multitenancy is local-first host composition, not an adversarial, distributed multi-tenant SaaS platform.
- The trusted host owns principal attestation, catalog construction, capability lifecycles, and separate company compositions. Static validation cannot replace those duties.
