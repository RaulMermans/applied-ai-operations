# Applied AI Operations — Local V1 Release Candidate

**Label:** `aao-local-v1-rc`  
**npm:** not published (`private: true`, version `0.0.0`)  
**Distribution:** source repository  
**Deployed:** no  
**Supported for production SaaS:** no

## What this candidate is

A reproducible source checkout that a developer can install with Node 20 and pnpm 10.26.0, execute governed workflows offline, inspect evidence, run Evals and the security suite, and read an honest limitations list.

## What shipped in the flagship (already in tree)

Sprints 1–29: Workflow Runtime, Model/Tool runtimes, MCP stdio, Governance, Approval, durability, Trace/Metrics/Audit, Evaluation gates, Framework surface, Toolbox, three proof workflows, company portability, Capability Packs, Control Center, security hardening including Sprint 29C continuation ownership and Audit coverage.

Sprint 30 adds: independent consumer proof, reproducible benchmarks, release qualification command, documentation reconciliation, and this acceptance contract.

## States

| State | Local V1 |
| --- | --- |
| Source available | yes |
| Package tarball tested (`pnpm pack`, never publish) | yes |
| npm published | no |
| Deployed | no |
| Supported for production | no (local/offline candidate only) |

## Upgrade / next

Durable Approval storage on the Framework path, npm publication of a closed dependency set, and remote operator authentication are explicitly deferred. Do not infer them from this candidate.
