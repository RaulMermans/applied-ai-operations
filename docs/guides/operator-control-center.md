# Operator Control Center Guide

The Control Center is a **read-only** inspection surface. It cannot run Workflows, approve requests, or change configuration.

## CLI

```bash
# General inspection
pnpm aao inspect overview
pnpm aao inspect companies | packs [--company <id>] | workflows | runs | evals | approvals [<id>]

# Guided Integration Diagnostics (Sprint 28)
pnpm aao inspect readiness --company <company-id> --pack <pack-ref> [--format text|json]

# Advanced Run Inspector (Sprint 28)
pnpm aao inspect run <run-id> [--view default|nodes|timeline] [--format text|json]
```

### Guided Integration Diagnostics CLI
Inspects company readiness for a capability pack, breaking down requirements across categories (workflow, tools, models, integrations, governance, evaluation) with verified proof status and deterministic remediation guidance:

```bash
pnpm aao inspect readiness --company company.northstar --pack pack.change-risk-assessment@1.0.0
```

### Advanced Run Inspector CLI
Inspects execution topology and trace correlation:
- `--view default`: Authoritative status, duration, node counts, approval/evaluation linkages, and root-cause diagnostics.
- `--view nodes`: Node execution map showing planned vs executed nodes, attempts, model/tool calls, token consumption, and failure reasons.
- `--view timeline`: Chronological execution attempts timeline with duration, tool/model invocations, retry status, and recovery replays.

```bash
pnpm aao inspect run run.northstar.cr.retry --view nodes
pnpm aao inspect run run.northstar.ops.recovery --view timeline
```

## HTTP API

The inspection API exposes deterministic read-only endpoints:

```text
GET /api/v1/inspection/overview
GET /api/v1/inspection/companies
GET /api/v1/inspection/packs
GET /api/v1/inspection/runs/:runId
GET /api/v1/inspection/runs/:runId/trace
GET /api/v1/inspection/companies/:companyId/packs/:packRef/diagnostics   # Guided Diagnostics
GET /api/v1/inspection/runs/:runId/analysis                              # Advanced Node & Attempt Inspection
```

## Local Browser UI

```bash
pnpm dev:control-plane   # loopback host (default 127.0.0.1:4000)
# open http://127.0.0.1:4000/
```

Views:
- **View 1: Overview & source health** — High-level counts, provenance banner, and source connectivity.
- **View 2: Companies, Packs & verified compatibility** — Company configurations, pack requirements, and verified snapshot compatibility. Clicking a pack leads to its **Guided Integration Diagnostics** page.
- **View 3: Workflows, known Runs, Approvals & Evaluations** — Pinned workflow plan fingerprints, known execution runs with clickable links, human approval records, and evaluation test reports.
- **Pack Integration Diagnostics**: Navigate to `/control-center/companies/:companyId/packs/:packRef` to inspect overall readiness, category requirement breakdowns, satisfied/missing/incompatible elements, and actionable remediation steps.
- **Advanced Run Inspector**: Navigate to `/control-center/runs/:runId` (or click any Run ID in the table) to inspect:
  - Authoritative lifecycle state, execution duration, and token usage summary.
  - Node execution map with planned vs executed status, attempt counts, and error highlights.
  - Interactive node detail drawer (`/control-center/runs/:runId?nodeId=<nodeId>`) displaying node lifecycle, attempts, model calls, tool calls, and error diagnostics.
  - Attempts timeline with retry and recovery replay markers.
  - Associated human approval events and evaluation test reports.

### Demonstration Data Provenance

The bundled default source is **offline demonstration fixture evidence**, not live operations. Every fixture-backed page displays the persistent banner:

```text
DEMO DATA — NOT LIVE OPERATIONS
```

A completed Run in demo fixtures demonstrates inspection rendering, not that a live company workflow recently executed. Non-loopback hosts disable inspection routes.

## Reading the Statuses

### Capability Pack Readiness Statuses
- `READY`: All requirements (workflow, tools, model policies/capabilities, integrations, governance, evaluation) are verified against independent `ProofRegistrationSnapshot` evidence.
- `BLOCKED`: One or more requirements are demonstrably missing or incompatible with company configuration or proof registrations.
- `NOT_VERIFIED`: No independent registration evidence was supplied (`PACK_EVIDENCE_UNAVAILABLE`). The pack is configured and enabled by the company, but runtime tool and model registrations have not been independently proven.
- `UNAVAILABLE`: The underlying inspection source or snapshot evidence could not be queried.

### Requirement Statuses
- `SATISFIED`: The requirement was independently proven present and compatible.
- `MISSING`: The required tool, model policy, integration slot, or evaluation profile was not found.
- `INCOMPATIBLE`: The registered capability or plan fingerprint conflicts with the pack requirement.
- `NOT_VERIFIED`: Proof evidence is absent; compatibility cannot be asserted.
- `UNAVAILABLE`: Inspection source was unable to resolve the requirement.

### Run Lifecycle Statuses
- `COMPLETED`: Run finished successfully according to authoritative runtime state.
- `FAILED`: Run halted due to a terminal failure or exhausted retries.
- `PENDING_APPROVAL`: Execution paused awaiting a human governance approval decision.
- `REJECTED`: A human reviewer formally rejected execution authorization.
- `UNKNOWN`: The run status cannot be determined because authoritative runtime/durability state is missing (`statusSource: unavailable`). The trace is shown for observation, but AAO never infers lifecycle status from trace events alone.

### Token Accounting Semantics
- If token usage is tracked in underlying trace evidence: Prompt, completion, and total tokens are reported.
- If token usage is not recorded in evidence (e.g. `run.arbor.di.001`): The inspector explicitly reports `"Not recorded"` (`recorded: false`). AAO never substitutes `0` for unrecorded token usage.

## Offline Proof & Smokes

```bash
# Offline demo proof
pnpm run proof:operator-inspection

# Sprint 27 smoke (Foundation inspection)
node examples/operator-inspection/smoke/sprint27.mjs

# Sprint 28 smoke (Diagnostics & Advanced Run Inspector)
node examples/operator-inspection/smoke/sprint28.mjs
```
