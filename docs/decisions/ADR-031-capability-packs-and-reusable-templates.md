# ADR-031: Capability Packs & Reusable Business Templates

Status: accepted (Sprint 26)

## Context

Sprints 22 through 25 established the foundational flagship workflows and multi-company portability architecture of Applied AI Operations (AAO):
- **Sprint 22**: Company Research (`company_research.proof@1.0.0`) over governed public-web tools, Toolbox operations, and citation-grounded synthesis.
- **Sprint 23**: Document Intelligence (`document_intelligence.proof@1.0.0`) with isolated PDF extraction, span segmentation, and evidence-anchored analysis.
- **Sprint 24**: Operational Request (`operational_request.proof@1.0.0`) with proposal interpretation, human approval waitpoints, and governed local draft creation.
- **Sprint 25**: Company Configuration & Portability, proving that Northstar Commerce and Arbor Consulting can execute the same three workflows with distinct model bindings, providers, and Governance without core forks.

In Sprint 26, we package these proven business capabilities into reusable, versioned **Capability Packs** that a host application or enterprise can select, inspect, validate for compatibility, and activate without rebuilding workflows, copying execution graphs, or weakening Governance.

## Decision

### 1. Declarative Capability Pack Composition, Not a New Runtime

A Capability Pack is a **versioned, declarative contract** (`CapabilityPackManifestV1`) describing an existing executable business capability, its exact workflow binding, required Tools, required Model Policies, required integration slots, preliminary permission requirements, human approval requirements, execution outcome class, and evaluation verification profile.

We explicitly reject:
- Creating a separate Capability Pack Runtime or execution engine;
- Creating a second Tool Registry or Approval Engine;
- Introducing an autonomous Agent for pack selection or installation;
- Supporting dynamic code loading, plugin marketplaces, or remote package execution.

```text
                  AAO CORE
                     |
                     v
               AAO Framework
                     |
                     v
            Capability Pack Catalog
                     |
             Select Exact Pack
                     |
                     v
           Validate Pack Contract
                     |
                     v
         Resolve Trusted Capabilities
                     |
                     v
           Company Configuration
                     |
                     v
            Governed Composition
                     |
             +-------+-------+
             |               |
             v               v
          Company A       Company B
             |               |
             +-------+-------+
                     |
                     v
           Same Pack Definition
                     |
                     v
           Same Workflow Contract
                     |
                     v
              AAO Runtime
```

### 2. Responsibility Boundaries: Toolbox vs. Workflow vs. Pack vs. Company Configuration

| Layer | Responsibility | Owns Authority? |
|---|---|---|
| **Tool / Toolbox (`@aao/toolbox`)** | Single governed capability or curated collection of provider-neutral Tools | No — Tool Runtime owns execution & authorization |
| **Workflow (`@aao/workflow-dsl`)** | Deterministic directed graph of nodes (deterministic, model, tool, approval) | No — Runtime owns state transitions |
| **Capability Pack (`@aao/capability-packs`)** | Reusable business operation contract + dependency manifest + compatibility rules + eval profile | No — Descriptive metadata only |
| **Company Configuration (`@aao/config`)** | Organization-specific model bindings, integration provider refs, and Governance policy | Defines company policy within Core rules |
| **AAO Runtime (`@aao/framework`)** | Authoritative execution, admission enforcement, Tool authorization, and Approval waitpoints | **Yes** |

### 3. Exact Identity and Four Distinct Fingerprints

Every Capability Pack uses exact SemVer (`packId@MAJOR.MINOR.PATCH`). Version ranges (`^1.0.0`, `>=1.0`), tags (`latest`), and unversioned references are rejected.

AAO preserves four distinct cryptographic/identity concepts that are never conflated:

1. **Workflow Plan Fingerprint**: SHA-256 hash of the compiled executable workflow plan.
2. **Capability Pack Fingerprint**: SHA-256 hash of the canonical JSON representation of `CapabilityPackManifestV1`.
3. **Company Configuration Fingerprint**: SHA-256 hash of the validated `CompanyManifestV1`.
4. **Run ID**: Unique correlation identifier for an individual execution instance.

A Pack manifest fingerprint provides deterministic identity and drift detection; it is **not** software supply-chain code attestation.

### 4. Exact Workflow Pinning

Each Capability Pack pins its target workflow ID, exact version, and expected 64-character `planFingerprint`. During compatibility preflight, the trusted host independently obtains the prepared workflow's actual `planFingerprint` and compares it against the pack's pinned value. Any discrepancy fails closed with `PACK_WORKFLOW_MISMATCH` before any Run can start.

### 5. Pack Metadata Is Never Authority

Declaring `preliminaryPermissions: ["read_only"]` or `approval.required: true` in a Capability Pack manifest informs preflight validation and human operators, but **grants zero runtime permissions**.
- Manifests containing authority-override fields (`handler`, `execute`, `script`, `modulePath`, `dynamicImport`, `eval`, `skipAuthorization`, `disableApproval`, `forceSuccess`, `allowExternalEffects`) are rejected at validation time with `PACK_INVALID_MANIFEST`.
- Unsupported permission classes (`external_side_effect`, `destructive`, `sensitive_data`) remain blocked.
- Every execution through an activated pack facade still invokes `requireCompanyAdmission()`, canonical Governance evaluation, Tool Runtime Authorization, and the Approval Engine.

### 6. Separate Company Pack Selection Contract (`CompanyPackSelectionV1`)

To preserve `CompanyManifestV1` compatibility and configuration fingerprints from Sprint 25, company pack adoption is represented via a dedicated, strictly validated contract (`CompanyPackSelectionV1`) specifying `companyId` and exact `packRefs`.

### 7. Immutable Pack Catalog

`createCapabilityPackCatalog()` stores registered `CapabilityPack` definitions in a private internal map, rejects duplicate registrations with `PACK_DUPLICATE_REF`, sorts listings deterministically by code units, and returns deep-frozen snapshots.

### 8. Evaluation Profiles as Verification Evidence

Each pack references an exact evaluation profile (`aao.company-research.evals@1.0.0`, `aao.document-intelligence.evals@1.0.0`, `aao.operational-request.evals@1.0.0`) executed by the canonical Evaluation Runtime (`@aao/evaluation`) and its deterministic graders. Passing an Eval profile provides verification evidence; it never bypasses runtime Governance or authorization.

## Consequences

### Positive
- Enterprises can adopt the three flagship workflows (`aao.company-research@1.0.0`, `aao.document-intelligence@1.0.0`, `aao.operational-request@1.0.0`) purely through validated configuration and host capability bindings.
- Zero workflow graph duplication across companies or packs.
- Missing tools, missing model policies, missing integration slots, disabled company proofs, and missing governance roles fail fast during preflight before any model or tool call occurs.

### Limitations & Non-Goals
- **Local trusted host**: Pack definitions and workflows are resolved from local checked-in packages; there is no remote package registry or dynamic plugin downloading.
- **No pack-to-pack dependency graph**: Packs are self-contained units referencing canonical Tools, Model Policies, and Workflows directly.
