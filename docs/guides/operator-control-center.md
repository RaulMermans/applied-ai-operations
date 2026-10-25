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

Views: Overview & source health; Companies, Packs & verified compatibility; Workflows, known Runs, Approvals & Evaluations.

The bundled source is offline demonstration fixture evidence, not live operations. Non-loopback hosts disable inspection routes.

## Reading the statuses

- `COMPATIBLE` means trusted registration evidence was validated; `NOT_VERIFIED` means it was not available.
- `UNKNOWN` Run status means no authoritative Runtime/Durability state was supplied; the Trace is shown as observation only.
- `REGISTERED` evaluation means a profile exists but has not been executed.

Demo and smoke: `pnpm proof:operator-inspection`, `node examples/operator-inspection/smoke/sprint27.mjs`.
