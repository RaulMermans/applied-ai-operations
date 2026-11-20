# ADR-035 — Local V1 source distribution and release qualification

Status: Accepted  
Date: 2026-11-20

## Context

AAO packages are a private pnpm workspace (`private: true`, `version: 0.0.0`, `workspace:*`). That is correct for an internal monorepo and does not, by itself, create an independently installable npm ecosystem. Local V1 needs a truthful distribution contract and a repeatable qualification path that reuses existing CLI, Runtime, Eval, security, and pack smokes.

## Decision

1. **Local V1 is source-distributable.** The supported consumer path is: clone, `pnpm install --frozen-lockfile`, `pnpm build`, import compiled workspace packages. npm publication is deferred until a complete production dependency closure can be published without `workspace:*`.
2. **Do not strip `private: true` or bump versions for appearance.** Packed tarballs are inspected, never published.
3. **Release qualification is a script over existing commands** (`pnpm release:verify:local-v1`), not a second validation framework, Agent, Workflow Runtime, or Model Router.
4. **Security and correctness are hard gates.** Benchmarks are descriptive unless a later ADR sets variance-tolerant thresholds.
5. **`createAAO()` stays a trusted-host façade.** Company-host hardening (ADR-034) is opt-in and is not implied by the Framework root.

## Consequences

- External developers follow [getting-started-local-v1](../guides/getting-started-local-v1.md).
- A packed standalone `@aao/framework` install is documented as unsupported.
- Limitations stay in [local-v1-limitations.md](../release/local-v1-limitations.md) rather than being “fixed” by new infrastructure in this sprint.
