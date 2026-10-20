# Company Configuration & Portability Proof

Sprint 25 ([ADR-030](../decisions/ADR-030-company-configuration-portability.md)) establishes AAO's fourth milestone: **Company Configuration & Portability: Multi-Company Composition Without Core Forks**.

Given validated company configurations and trusted host-supplied capabilities, AAO composes company-specific execution environments for two distinct fictional enterprises—**Northstar Commerce** and **Arbor Consulting**—executing the three flagship workflows using the exact same underlying implementations.

Code: [`examples/company-portability`](../../examples/company-portability/README.md) (`@aao/example-company-portability`, private). Consumes: `@aao/config`, `@aao/framework`, `@aao/example-company-research`, `@aao/example-document-intelligence`, `@aao/example-operational-request`.

## Fictional Company Profiles

| Attribute | Company A: Northstar Commerce | Company B: Arbor Consulting |
|---|---|---|
| **Company ID** | `northstar-commerce` | `arbor-consulting` |
| **Domain** | Omnichannel retail inventory synchronization | Enterprise strategy & management advisory |
| **Model Runtime** | Native Model Adapter (`northstar.model.native`) | Vercel AI SDK MockLanguageModelV3 (`arbor.model.vercel`) |
| **Web Search Provider** | `northstar.web-provider` (Retail corpus) | `arbor.web-provider` (Advisory corpus) |
| **Document Provider** | `northstar.doc-provider` (Supplier agreements) | `arbor.doc-provider` (Master services agreements) |
| **Draft Repository** | `northstar.draft-repository` (Retail drafts) | `arbor.draft-repository` (Consulting drafts) |
| **Principals** | `ns.analyst`, `ns.operator`, `ns.manager` | `arb.researcher`, `arb.requester`, `arb.manager` |
| **Approval Role** | `operations.approver` (`ns.manager`) | `operations.approver` (`arb.manager`) |

## Multi-Company Composition Architecture

```text
               Shared Workflow Definitions (AAO Core)
               ├── company_research.proof@1.0.0
               ├── document_intelligence.proof@1.0.0
               └── operational_request.proof@1.0.0
                              │
            ┌─────────────────┴─────────────────┐
            ▼                                   ▼
    Northstar Commerce                   Arbor Consulting
    ┌───────────────────────────┐       ┌───────────────────────────┐
    │ Manifest: northstar       │       │ Manifest: arbor           │
    │ Config FP: 8144c5a41a...  │       │ Config FP: dd5477da6f...  │
    │                           │       │                           │
    │ Native Model Adapter      │       │ Vercel AI SDK Adapter     │
    │ Northstar Web Corpus      │       │ Arbor Advisory Corpus     │
    │ Supplier Agreements       │       │ Master Services MSAs      │
    │ Northstar Governance      │       │ Arbor Governance          │
    │ Northstar Draft Repo      │       │ Arbor Draft Repo          │
    └───────────────────────────┘       └───────────────────────────┘
```

## 6-Scenario Matrix Execution

All six matrix scenarios execute successfully without workflow code duplication:

| Scenario | Company | Workflow | Model / Provider | Result |
|---|---|---|---|---|
| 1 | Northstar Commerce | Company Research | Native Model + Northstar Web | COMPLETED |
| 2 | Arbor Consulting | Company Research | Vercel AI + Arbor Web | COMPLETED |
| 3 | Northstar Commerce | Document Intelligence | Native Model + Northstar Docs | COMPLETED |
| 4 | Arbor Consulting | Document Intelligence | Vercel AI + Arbor Docs | COMPLETED |
| 5 | Northstar Commerce | Operational Request | Native Model + Northstar Approver | COMPLETED (1 draft) |
| 6 | Arbor Consulting | Operational Request | Vercel AI + Arbor Approver | COMPLETED (1 draft) |

## Plan Fingerprint vs Configuration Fingerprint Evidence

The proof provides mathematical verification that the workflows are unmodified across companies while configurations are strictly distinct:

| Workflow | Northstar Plan Fingerprint | Arbor Plan Fingerprint | Equal? |
|---|---|---|---|
| **Company Research** | `d316887874d40e7225c56fa8a89ee1c94d0ca9ef7f955d8ee9dcfdbf3bb0eeea` | `d316887874d40e7225c56fa8a89ee1c94d0ca9ef7f955d8ee9dcfdbf3bb0eeea` | **YES** |
| **Document Intelligence** | `ea415041aa2373edc96a7516ca4d0b1359c381c818816f1bca554909c009d784` | `ea415041aa2373edc96a7516ca4d0b1359c381c818816f1bca554909c009d784` | **YES** |
| **Operational Request** | `8323d4dca07e54cbfaeef95b77c5e88849c7bc290885c39ee2ecb315ca941bf5` | `8323d4dca07e54cbfaeef95b77c5e88849c7bc290885c39ee2ecb315ca941bf5` | **YES** |

| Company | Configuration Fingerprint |
|---|---|
| **Northstar Commerce** | `8144c5a41a1f07d9c66cb1e97ae2b8a7f920257bbfe2d7e484a0c5c36394553b` |
| **Arbor Consulting** | `dd5477da6fb5ed53fe304b78bb247bc77f72205568eb40698114f09d13e3b9e4` |

A configuration mutation (e.g. updating `displayName`) immediately yields a new configuration fingerprint (`c25f089d...`) while the workflow plan fingerprint remains 100% bit-for-bit identical.

## Local Isolation Evidence and Limits

1. **Provider Isolation**: Web provider calls are isolated to the company's designated provider. During Northstar research, Arbor's provider receives 0 calls.
2. **Document Partitioning with Overlapping References**: Both companies configure the document reference `fixture.contract-001`. Northstar resolves `northstar-supplier-agreement.txt` with supplier payment terms; Arbor resolves `arbor-master-services.txt` with consulting terms. No cross-tenant document content is leaked.
3. **Governance Refusal**: A valid Arbor Research request made with a Northstar principal fails at the search Tool with canonical `TOOL_AUTHORIZATION_REQUIRED` before Arbor web calls. The same request succeeds with an authorized Arbor principal. The Research planning model runs before the search Tool, so the refusal does not prove zero model calls.
4. **Approval Verification Refusal**: An approval granted by Northstar's manager cannot be verified or used to authorize a draft inside Arbor Consulting's environment.
5. **Draft Repository Partitioning**: In-memory draft repositories are partitioned. Drafts staged by Northstar cannot be accessed or modified by Arbor.
6. **Zero External Side Effects**: All drafts are stored in host memory with `externalExecution: "not_executed"`.

## Evaluation & Smoke Verification

- **36 Judged Evaluation Cases**: Evaluated across 6 canonical graders (`aao.run-outcome`, `aao.trace-contract`, `aao.model-call`, `aao.tool-usage`, `aao.approval-compliance`, `aao.state-assertion`). 100% pass rate.
- **15 Negative Evaluation Criteria**: All negative criteria (unknown capabilities, disabled proofs, cross-tenant principal tampering, unauthorized approvers, schema mutations) pass.
- **Compiled Smoke Test**: `examples/company-portability/smoke/sprint25.mjs` imports exclusively from compiled output (`dist/`) and emits `SPRINT_25_COMPANY_PORTABILITY_PROOF_SMOKE_OK`.
- **Demo Runner**: `pnpm proof:company-portability` builds and executes the full live demonstration offline.
