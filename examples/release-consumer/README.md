# Local V1 release consumer

Offline golden path for AAO Local V1: define a Workflow, register Tools, configure Governance, run, inspect, evaluate. Capability Pack adoption uses Northstar Commerce / Arbor Consulting fixtures.

```sh
pnpm build
pnpm --filter @aao/example-release-consumer proof
pnpm --filter @aao/example-release-consumer smoke:sprint30
```

No API keys. The first run is simulated.

The supported consumer path is this monorepo after `pnpm install`. A packed standalone `@aao/framework` tarball cannot resolve unpublished `workspace:*` packages; that is a documented Local V1 limitation, not a hidden fallback to TypeScript source aliases.
