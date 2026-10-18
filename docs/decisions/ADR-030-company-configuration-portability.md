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

## Consequences

### Positive
- **Proven Portability**: The 3 flagship workflows run against Northstar Commerce (retail inventory sync, native model adapter, supplier agreements, merchandise approval) and Arbor Consulting (management advisory, Vercel AI SDK mock model, client MSA, client display name approval) without altering workflow code.
- **Zero Core Forks**: AAO Core (`@aao/framework`, `@aao/runtime`, `@aao/tool-runtime`, `@aao/governance`, `@aao/approval`) remains untouched.
- **Fail-Closed Isolation**: Cross-company principal invocations fail closed; cross-company approvals are rejected; overlapping document refs resolve strictly within company provider bounds.
- **Verifiable Identity**: Plan fingerprints prove shared compilation; configuration fingerprints prove distinct governed environments.

### Trade-offs & Limitations
- Composition is immutable at construction time; updating a company configuration requires instantiating a new composition.
- Multitenancy is local-first host composition, not an adversarial, distributed multi-tenant SaaS platform.
