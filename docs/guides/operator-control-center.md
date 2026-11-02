# Operator Control Center Guide

The Control Center is a **read-only** inspection surface. It cannot run Workflows, approve requests, or change configuration.

## CLI

```bash
pnpm aao inspect overview
pnpm aao inspect companies | packs [--company <id>] | workflows | runs | evals | approvals [<id>]
pnpm aao inspect run <run-id> --format json
```

## Local browser UI

```bash
pnpm dev:control-plane   # loopback host (default 127.0.0.1:4000)
# open http://127.0.0.1:4000/
```

Views:
- **View 1: Overview & source health** — High-level counts, provenance banner, and source connectivity.
- **View 2: Companies, Packs & verified compatibility** — Company configurations, pack requirements, and verified snapshot compatibility.
- **View 3: Workflows, known Runs, Approvals & Evaluations** — Pinned workflow plan fingerprints, known execution runs with clickable links, human approval records, and evaluation test reports.
- **Run Detail Inspection**: Navigate directly to `/control-center/runs/:runId` (or click any Run ID in the table) to inspect authoritative run lifecycle state, bounded trace timeline, associated approvals, and evaluation reports.

### Demonstration Data Provenance

The bundled default source is **offline demonstration fixture evidence**, not live operations. Every fixture-backed page displays the persistent banner:

```text
DEMO DATA — NOT LIVE OPERATIONS
```

A completed Run in demo fixtures demonstrates inspection rendering, not that a live company workflow recently executed. Non-loopback hosts disable inspection routes.

## Reading the statuses

- `COMPATIBLE`: Validated against independent, trusted `ProofRegistrationSnapshot` evidence.
- `NOT_VERIFIED`: No independent registration evidence was supplied (`PACK_EVIDENCE_UNAVAILABLE`). The pack is configured and enabled by the company, but runtime tool and model registrations have not been independently proven.
- `INCOMPATIBLE`: Required tools or model policies are missing from the proof snapshot, or the company explicitly disabled the proof.
- `UNKNOWN`: The run status cannot be determined because authoritative runtime/durability state is missing (`statusSource: unavailable`). The trace is shown for observation, but AAO never infers lifecycle status from trace events alone.
- `REGISTERED`: An evaluation profile is declared but has not been executed.

Demo and smoke: `pnpm proof:operator-inspection`, `node examples/operator-inspection/smoke/sprint27.mjs`.
