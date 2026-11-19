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
pnpm aao inspect readiness --company northstar-commerce --pack aao.company-research@1.0.0
```

### Advanced Run Inspector CLI
Inspects execution topology and trace correlation:
- `--view default`: Authoritative status, duration, node counts, approval/evaluation linkages, and root-cause diagnostics.
- `--view nodes`: execution counters, then the node map: planned vs executed nodes, execution occurrences, attempts, scheduled retries, Tool/model refs, token accounting and failure reasons.
- `--view timeline`: execution counters, then one line per observed node attempt (step, attempt, span, outcome, Tool/model invocations, tokens, reason code, recovery replay), then unattributed evidence.

```bash
pnpm aao inspect run run.northstar.cr.retry --view timeline    # explicit Tool retry: 2 attempts, 1 retry
pnpm aao inspect run run.northstar.cr.repeat --view nodes      # repeated node + PARTIAL tokens
pnpm aao inspect run run.northstar.ops.recovery --view timeline # recovery replay
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
- `READY`: the canonical compatibility validator (`validatePackCompatibility`) passed against trusted registration evidence. This is the only path to `READY`; a list of positive requirement labels never overrides the verdict.
- `BLOCKED`: the canonical validator found an incompatibility. It stops at the first one, so `reasonCode` names only that one. Read the requirement list for every problem.
- `NOT_VERIFIED`: registration evidence needed for the verdict is absent (`PACK_EVIDENCE_UNAVAILABLE`), for example no snapshot or no eval-profile registration list.
- `UNAVAILABLE`: the inspection source could not be queried.

### Requirement Statuses
Each requirement is checked **independently** against its own evidence, so several problems appear at once (for example a missing Tool, a missing Model Policy and a missing Eval profile all show `MISSING` together). These statuses explain the verdict; they never grant readiness or execution authority.

- `SATISFIED`: that requirement's own evidence was found and satisfies it (exact Tool version, registered policy, one binding/adapter pair covering every required capability, matching workflow fingerprint, enabled proof, defined approver roles, registered eval profile).
- `MISSING`: the evidence source is present and confirms the item is absent.
- `INCOMPATIBLE`: the item exists but violates the contract (wrong version, unsupported capability, fingerprint mismatch, proof disabled, undefined approver role).
- `NOT_VERIFIED`: the evidence that would decide it is absent, or inspection cannot verify it in principle:
  - **Integration slots**: a configured provider reference is not proof the provider is live.
  - **Preliminary permissions**: Authorization checks these per principal at run time.
  - **Model capabilities** when a binding's adapter evidence is missing.
- `UNAVAILABLE`: the source could not be queried. This is never reported as `MISSING`.

A registered Eval profile is only *registered*: it does not mean its Evals passed, and grader definitions are not part of registration evidence. Approval-role configuration is not any particular Run's approval decision.

### Run Lifecycle Statuses
- `COMPLETED`: Run finished successfully according to authoritative runtime state.
- `FAILED`: Run halted due to a terminal failure or exhausted retries.
- `PENDING_APPROVAL`: Execution paused awaiting a human governance approval decision.
- `REJECTED`: A human reviewer formally rejected execution authorization.
- `UNKNOWN`: The run status cannot be determined because authoritative runtime/durability state is missing (`statusSource: unavailable`). The trace is shown for observation, but AAO never infers lifecycle status from trace events alone.

### Execution Counters

| Label | What it counts |
|---|---|
| Trace Events | Lifecycle events in the canonical Trace. A single Tool step emits four (`node.started`, `tool.call.started`, `tool.call.completed`, `node.completed`); that is **one** attempt. |
| Node Execution Occurrences | Distinct node + workflow step pairs. |
| Node Attempts | Observed `node.started` events, excluding recovery replays. One per actual attempt. |
| Scheduled Retries / Exhausted Retries | Explicit `retry.scheduled` / `retry.exhausted` evidence. |
| Recovery Replays | Attempts re-executed during durable recovery (`recoveryReplay: true`). |
| Tool Physical Invocations | Actual handler invocations (`tool.call.started`); a blocked call is not one. |
| Tool Logical Executions | Distinct Tool execution ids. |
| Model Invocations | Distinct model invocation attempts; started + completed is **one**. |

- **Retries vs. repeated nodes**: a retry is a new attempt at the *same* step after `retry.scheduled`; the node shows more attempts than executions. A node that runs again at a *different* step (`run.northstar.cr.repeat`, `plan` at steps 1 and 3) is a separate execution occurrence with its own span and is not a retry (`NODE_REPEATED`).
- **Recovery replay**: shown as its own attempt row marked `recovery replay`, on the same logical span as the attempt it replays. It is counted under Recovery Replays, not Node Attempts.
- **Unattributed evidence**: an attempt-scoped event (for example a model call) whose span links to no observed `node.started` is listed separately and not credited to any node. A Tool event without a node parent span is invalid Trace evidence, so the whole Trace is reported corrupt.

### Token Accounting Semantics
- **COMPLETE**: every model invocation reported input, output and total tokens. "COMPLETE (0 model invocations)" means no model calls were made; it does not mean usage is missing.
- **PARTIAL**: some invocations reported usage and some failed, never finished, or omitted a field. Totals are labelled **known recorded totals** and are lower bounds, not the Run's full usage (`run.northstar.cr.repeat`: 250 known tokens, 1 of 2 invocations with usage).
- **NOT RECORDED**: invocations occurred and none reported usage.
- An unknown value is shown as "not recorded" and never as `0`. Missing `totalTokens` is not derived from input + output.

### Why advanced Run inspection can be unavailable
Basic Run inspection (`aao inspect run <runId>`) works from summaries. Node attempts, counters and token accounting need the canonical Trace itself. If the inspection source can only provide summaries, `--view nodes|timeline` and `/analysis` return `INSPECTION_SOURCE_UNAVAILABLE`. The browser run page keeps the basic view and states that advanced inspection is unavailable. AAO never rebuilds Trace evidence from redacted summaries.

## Offline Proof & Smokes

```bash
# Offline demo proof
pnpm run proof:operator-inspection

# Sprint 27 smoke (Foundation inspection)
node examples/operator-inspection/smoke/sprint27.mjs

# Sprint 28 smoke (Diagnostics & Advanced Run Inspector)
node examples/operator-inspection/smoke/sprint28.mjs
```
