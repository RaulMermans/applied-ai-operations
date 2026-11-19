# Contributing

Thanks for your interest in AAO.

## Setup

```sh
pnpm install --frozen-lockfile
pnpm check   # must pass before you open a PR
```

[docs/engineering/local-development.md](docs/engineering/local-development.md) has the full command reference.

## Ground rules

These come from [AGENTS.md](AGENTS.md) and [ARCHITECTURE.md](ARCHITECTURE.md):

- **The workflow comes first.** Agents are optional and bounded within workflows.
- **Models propose and never authorize.** Validation, policy, permissions, approvals, and side effects belong to deterministic code.
- **AAO owns its contracts.** Framework and provider types stay behind adapters.
- **Each concept has one canonical implementation.** Company-specific requirements must not change core semantics.
- **Never weaken a test or an eval baseline** to make a change pass. A baseline change needs human review.
- **Architectural changes need an ADR** in [docs/decisions/](docs/decisions/).

## Pull requests

- Keep each PR focused on one change.
- Add or update tests for any behavior you change.
- Update the relevant docs and ADRs in the same PR.
