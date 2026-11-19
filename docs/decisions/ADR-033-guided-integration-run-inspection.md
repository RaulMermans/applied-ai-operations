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

## Amendment (Sprint 28C): Execution Evidence Integrity, Attempt Correlation & Diagnostic Accuracy

Status: accepted. This amends the decision above; it does not replace it.

Decision: deterministic evidence correlation using existing Observability contracts, fail-closed source handling, and independently verified requirement diagnostics. No new runtime, registry, storage, agent or execution authority.

### Defects corrected

1. **Lifecycle events were counted as attempts.** The original projection appended an attempt summary for every `node.*`, `tool.call.*`, `model.call.*` and `approval.*` event and grouped node events by the payload `attempt` field (defaulting to 1). The UI showed the event count as "Total Attempts". One Tool step (four events) therefore looked like four attempts. Two Tool invocations inside one node attempt looked like a node retry, and a node repeated at a later step was merged with its earlier execution.
2. **Lossy Trace reconstruction.** When a source had no advanced-inspection path, the service rebuilt `TraceEvent`, `RunRecord` and `ApprovalRecord` objects from the redacted `RunInspection` DTO using `as unknown as` casts, with invented timestamps and missing payload fields, and projected them as if they were canonical.
3. **Requirement statuses inherited the global verdict.** `validatePackCompatibility` throws on the first incompatibility. Every requirement not named by that one reason code defaulted to `SATISFIED`, so a missing Tool hid a missing Eval profile. Missing eval-registration evidence was coerced to `[]` and reported as a confirmed absence.
4. **Token accounting claimed completeness.** Any recorded usage set `recorded: true`, and formatters printed unknown fields as `0`.
5. **Read-only purity was asserted, not measured.** The purity test ended with `expect(true).toBe(true)`.

### Canonical execution identity

An attempt is exactly one `node.started` event, identified by node + step + attempt + canonical span (the span ID the recorder derives from node, step and attempt). The projection reuses `deriveRunMetrics` (ADR-021), which already defines node attempts, execution occurrences, recovery-replay attempts, retries, Tool physical vs logical invocations and model invocations. It does not introduce a competing algorithm. The inspector adds only the attachment of child evidence to attempts by `parentSpanId`/`spanId`. Lifecycle event count, execution occurrences, attempts, physical invocations and retries are separate, explicitly named counters. A repeated node ID at another step is a new execution occurrence, never a retry. A retry needs `retry.scheduled` evidence.

**Recovery replay** is an attempt with `recoveryReplay: true` on the same logical span as the attempt it replays. It is counted under recovery replays, not node attempts; later evidence on that span belongs to the replay. Attempt-scoped events with no attributable span are listed as unattributed evidence rather than credited to a node. A Tool event without a node parent is invalid Trace evidence, and the Trace is reported corrupt.

### Evidence source

`getAdvancedRunInspection` uses only a source method that projects canonical evidence (`KnownRunEvidence.traceEvents` or the `TraceStore`) before redaction. Without one, it confirms the Run exists and then fails with `INSPECTION_SOURCE_UNAVAILABLE`. An invalid Trace yields `corrupt` health with no attempts, counters or token totals. `validateTrace` is unchanged.

### Independently verified requirements

`diagnoseRequirementsIndependently` checks each requirement against its own evidence:

- exact Tool `id@version`;
- each Model Policy;
- model capabilities, satisfied only by one real binding/adapter pair that covers all of them;
- workflow identity and fingerprint;
- proof enablement;
- approver-role definitions;
- exact eval profile registration.

Absent evidence gives `NOT_VERIFIED`. `MISSING` requires a present source that confirms absence.

Two categories are always `NOT_VERIFIED`:

- **Integration slots**: a configured provider reference is not proof of a live provider.
- **Preliminary permissions**: authorized per principal at run time.

`validatePackCompatibility` remains the sole authority for `READY`. The granular statuses explain the verdict and grant nothing.

### Token completeness

`TokenUsageSummary` now carries `status: complete | partial | unavailable` (Observability `MetricCompleteness` semantics), `modelInvocations`, calls with and without usage, exact totals only when fully known, and `known*` recorded totals. A failed or unfinished invocation has unknown usage. Unknown values are omitted and rendered as "not recorded", never `0`. CLI and UI share `formatTokenUsageText` and `executionCounterRows`.

### Read-only purity evidence

Tests measure the read-only behavior instead of asserting it:

- a TraceStore `append` spy;
- a global `fetch` spy;
- before/after snapshots of all evidence;
- a package-boundary check that `@aao/operator-inspection` neither depends on nor imports any runtime, model, Tool, approval, durability, evaluation or integration package.

The demo and the compiled smoke report the same measurements.

### Known limitations

- Eval grader definitions are not part of registration evidence, so a `SATISFIED` eval profile means registered only, not graded or passed.
- Integration provider availability and per-principal permissions cannot be verified by inspection.
- Model events are not required by `validateTrace` to carry a node parent span. A model call emitted outside a node span is valid but unattributed.
- Attempts and per-attempt evidence IDs are bounded at 500 (`attemptsTruncated` flags truncation). Counters are always exact.
- The default CLI demo source now includes the extended fixture runs (`run.northstar.cr.retry`, `run.northstar.cr.repeat`, `run.northstar.ops.recovery`), so the documented commands work.
