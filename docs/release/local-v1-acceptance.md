# Local V1 acceptance matrix

Outcomes: `PASS`, `FAIL`, `NOT_VERIFIED`, `NOT_APPLICABLE`. `NOT_VERIFIED` is not a pass.

The executable verdict is `pnpm release:verify:local-v1`, which prints `LOCAL_V1_READY`, `LOCAL_V1_BLOCKED`, or (if the process cannot collect evidence) should be treated as `LOCAL_V1_NOT_VERIFIED`.

| Dimension | Required evidence | Expected |
| --- | --- | --- |
| Installation | Node 20 + pnpm 10.26.0, `pnpm install --frozen-lockfile` | PASS |
| Public API | Compiled `@aao/framework` consumer (`examples/release-consumer` + Framework smoke) | PASS |
| Workflow execution | Golden-path authorized lookup completes | PASS |
| Authorization | Unauthorized Tool → zero handler calls | PASS |
| Approval | Eligible approver, exactly one draft; duplicate continue does not add a draft | PASS |
| Portability | `pnpm proof:company-portability` — three workflows, two companies | PASS |
| Capability Packs | Three packs resolve; verified registrations vs demo `NOT_VERIFIED` | PASS |
| Inspection | CLI/API/UI projections; missing evidence stays UNKNOWN/NOT_VERIFIED | PASS |
| Evaluation | `pnpm eval:ci` PASS | PASS |
| Security | `pnpm proof:security-hardening` and Sprint 29 smoke | PASS |
| Durability | Existing durability tests + documented Approval-waiting restart limitation | PASS (limitation explicit) |
| Packaging | `pnpm pack` inventory: no secrets; npm publication deferred | PASS |
| Benchmarks | `pnpm benchmark:local-v1` produces a SHA-stamped JSON report | PASS (descriptive) |
| Documentation | Commands in `package.json` match guides | PASS |
| CI | Core verify + `pnpm release:verify:local-v1 --after-core` | PASS |
| Release state | Git SHA recorded in the verify report; no unauthorized publish | PASS |

npm publication, SaaS deployment, and remote operator auth are `NOT_APPLICABLE` for this candidate.
