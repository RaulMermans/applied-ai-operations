# Applied AI Operations

A reusable runtime and control layer for deploying governed AI workflows inside organisations.

## Current stage

Sprint 0A is a local-first substrate evaluation. This repository contains executable architectural proofs, not the final AAO platform implementation or a deployment target.

AAO's product thesis is workflow-first: it owns workflow, policy, run, trace, evaluation, and capability contracts while adapters keep underlying frameworks replaceable.

## Local use

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

The experiments live in `packages/substrate-spikes`; their evidence and recommendations are in `docs/research` and `docs/decisions`.
