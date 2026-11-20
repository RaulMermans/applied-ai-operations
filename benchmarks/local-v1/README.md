# AAO Local V1 benchmarks

Operational measurements of AAO, not a model-quality leaderboard.

```sh
pnpm build
pnpm benchmark:local-v1
```

Requires compiled workspace packages. Offline: fake/test model adapters only.

JSON reports are written to `benchmarks/local-v1/out/` (gitignored). Methodology and a labeled reference result: [docs/benchmarks/local-v1-results.md](../../docs/benchmarks/local-v1-results.md).

Scenarios A–H: compilation, governed read-only Tool, fake-adapter model workflow, Approval/draft, filesystem recovery, observability projections, Capability Pack preflight, modest in-process concurrency (1/4/8).
