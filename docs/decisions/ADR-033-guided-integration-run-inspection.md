# ADR-033: Guided Integration Diagnostics & Advanced Run Inspector Projections

- Status: Accepted (Sprint 28)
- Supersedes: none. Builds on ADR-030 (Company Configuration Portability), ADR-031 (Capability Packs & Reusable Templates), and ADR-032 (Operator Inspection & Control Center Foundation).

## Context

Sprints 22–27 established:
- Three governed flagship workflows (Company Research, Document Intelligence, Operational Request).
- Portable company manifests and proof isolation.
- Versioned, pinned Capability Packs.
- Verified compatibility contracts requiring independent registration evidence.
- Canonical Tool authorization and human Approval records.
- Operator inspection CLI, HTTP API, and Control Center foundation.

However, developers and operators still encountered friction when adopting Capability Packs or troubleshooting complex executions:
1. **Adoption Uncertainty**: Determining why a Capability Pack was or was not ready for a given company required manually cross-referencing company manifests, tool registries, model adapter declarations, integration slots, and eval profiles.
2. **Execution Opacity**: Investigating failed or retried workflow runs required piecing together raw trace event logs, calculating attempt counts, correlating runtime statuses with tool errors, and deciphering recovery replays.
3. **Absence of Actionable Guidance**: When compatibility failed or runs faulted, operators received opaque codes without deterministic remediation suggestions.

Developers required an evidence-backed diagnostic interface that answers:
- What is required to adopt a Capability Pack?
- Why is a company blocked or unverified?
- What specific steps should the developer take next?
- What happened during a workflow run across nodes, attempts, model calls, tools, approvals, and evaluations?

## Decision

Extend `@aao/operator-inspection` with deterministic, read-only diagnostic projections over existing AAO contracts:

```text
                   AAO CORE
                      |
          +-----------+-----------+
          |           |           |
          v           v           v
       Workflow     Capability   Run/Trace
         Plans        Packs       Evidence
          |           |           |
          +-----------+-----------+
                      |
                      v
             Existing Trusted
             Inspection Sources
                      |
                      v
             @aao/operator-inspection
                      |
            +---------+---------+
            |                   |
            v                   v
     Integration Diagnostics  Run Inspector
            |                   |
            +---------+---------+
                      |
              Shared DTOs
                      |
              +-------+-------+
              |       |       |
              v       v       v
             CLI     HTTP     UI
```

### Architectural Principles

1. **Deterministic Projection Over Authoritative Contracts**:
   - Zero new agents, zero new runtimes, zero new governance engines, zero new tool registries, zero new persistent run stores.
   - Zero execution authority, zero side effects (0 model calls, 0 tool invocations, 0 config mutations, 0 approval transitions).
   - Projections derive strictly from existing authoritative AAO contracts: `CompanyManifestV1`, `CapabilityPack`, `ProofRegistrationSnapshot`, `WorkflowDefinition`, `RunRecord`, and `TraceEvent`.

2. **Strict Evidence-Backed Status Hierarchy**:
   - `READY`: All requirements (workflow plan fingerprint, tools, model policies, model capabilities, integrations, governance, approvals, eval profiles) verified against independent registration evidence.
   - `BLOCKED`: A required component is demonstrably missing, incompatible, or disabled.
   - `NOT_VERIFIED`: Proof registration evidence is absent. The system NEVER assumes compatibility from pack metadata alone.
   - `UNAVAILABLE`: Inspection source is unable to provide authoritative data.

3. **Deterministic Remediation Mapping**:
   - Versioned mapping (`DETERMINISTIC_REMEDIATION_MAP`) translates canonical AAO failure reason codes into bounded, actionable suggestions for operators.

4. **Node-Oriented Execution Correlator**:
   - Correlates planned nodes from `WorkflowDefinition` with observed events from `TraceEvent[]` and authoritative `RunRecord`.
   - Distinguishes node execution statuses: `OBSERVED_COMPLETED`, `OBSERVED_FAILED`, `OBSERVED_STARTED`, `NOT_OBSERVED`, `EVIDENCE_INCOMPLETE`.
   - Preserves attempt chronology: multi-attempt retries, tool failure codes, recovery replays, approval resolutions.

5. **Token Usage Accounting Integrity**:
   - When evidence contains recorded token usage, aggregate prompt, completion, and total tokens faithfully.
   - When token accounting was omitted or disabled, explicitly report `recorded: false` and render `"NOT RECORDED"` / `"Not recorded"`.
   - Never substitute zero (`0`) for missing token evidence.

6. **Unified Read-Only Dispatch Across Three Surfaces**:
   - **CLI**:
     - `aao inspect readiness --company <id> --pack <ref> [--format text|json]`
     - `aao inspect run <runId> --view default|nodes|timeline [--format text|json]`
   - **HTTP API**:
     - `GET /api/v1/inspection/companies/:companyId/packs/:packRef/diagnostics`
     - `GET /api/v1/inspection/runs/:runId/analysis`
   - **Control Center UI**:
     - `/control-center/companies/:companyId/packs/:packRef`: Readiness cards, requirement checklist, next steps.
     - Enhanced `/control-center/runs/:runId`: Execution summary cards, node execution map, interactive node selection (`?nodeId=...`), attempts timeline, run diagnostics.

## Consequences

- Operators and developers can diagnose Capability Pack onboarding and run execution without reading internal engine code or inspecting raw JSON files.
- All three surfaces (CLI, HTTP API, Control Center UI) share identical deterministic schemas, DTOs, and formatting rules.
- Local-first architecture and bounded security guarantees are fully preserved: loopback guards, read-only GET methods, no external network dependencies, bounded string lengths and payload sizes.
