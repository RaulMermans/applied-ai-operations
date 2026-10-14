# Eval Baselines

An **Eval baseline** is one deliberately accepted evaluation state, kept for comparison ([ADR-023](../../docs/decisions/ADR-023-eval-analytics-ci-gates-and-adapter-verification.md), [eval analytics & CI](../../docs/architecture/eval-analytics-ci.md)). It is approved *evidence*, not policy:

- it never authorizes, approves, or configures execution;
- it is never loaded into an agent or model context (it is not Memory);
- CI reads it and never writes it.

| File | Baseline | Dataset | Gated by |
| --- | --- | --- | --- |
| `runtime-foundation.v1.json` | `runtime-foundation@1.0.0` | `aao.runtime-foundation@2.0.0` | `evals/gates/foundation-ci.v1.yaml` |

## Why baselines exist

A gate needs to answer "is this candidate at least as good as the state we accepted?" — not just "did every case pass?". The baseline records, per case, the logical identity, declared expectation, actual verdict, expectation verdict, and semantic verdict fingerprint. It also records suite counts and advisory operational measurements. It contains no evidence content: no Tool input/output, prompts, model output, state values, Approval subjects, or credentials. That makes it safe to commit publicly, and the privacy suite scans it.

## How comparison keys work

Cases are matched by slot (dataset id + case id) and compared through the **comparison key**: SHA-256 over `evalRef`, `graderRef`, `datasetRef`, `caseId`, `mode`, and `targetType`. The key excludes Run, Trace, provider, model, result id, and evidence fingerprint, so the same case judged on another day, provider, or Run has the same key.

If a definition, grader, or dataset version changes, the old and new results are **INCOMPATIBLE**, not a regression. The dataset version is the exception: a policy may explicitly list compatible baseline dataset versions. Otherwise a version change means proposing and reviewing a new baseline.

Regression is judged on *case expectations*, never on raw status: a negative case that expects `failed(APPROVAL_BYPASSED)` and gets it is `MATCHED`.

## Fixture fingerprint rules

Every OFFLINE case in a dataset pins the `evidenceFingerprint` of its fixture. If a fixture changes without a re-pinned dataset, the gate stops with `EVAL_FIXTURE_FINGERPRINT_MISMATCH` before evaluating anything. Nothing rewrites a pin automatically. The diagnostic prints the actual fingerprint so that a reviewer can re-pin it deliberately, in a new dataset version.

## Proposing a baseline update

1. Make the behavior or dataset change, then run `pnpm build && pnpm eval:ci` and read the findings.
2. Run `pnpm eval:baseline:propose -- --id runtime-foundation --version <new-version>`. It prints a proposal and writes nothing. The proposal lists any `unmatchedCases` and the `baselineRef` (id, version, fingerprint) to pin.
3. Commit the proposal's `baseline` object as a **new file**, for example `runtime-foundation.v2.json`. Never edit a committed baseline version in place.
4. In the same change, update the gate policy's `baselineRef` and bump the policy `version`.
5. Get it reviewed.

The gate refuses a baseline whose content does not match the policy's pinned fingerprint (`EVAL_BASELINE_INVALID`). An in-place edit therefore fails CI until it is re-pinned deliberately.

## Why CI never updates the baseline

If CI could accept its own output, a regression could become the new normal without a human noticing. Baseline acceptance is an external, reviewed repository decision. The CI commands have no write path at all, and there is no accept-everything flag.

## Review expectations

- **Explain every changed case expectation.** Especially check any case that is no longer `MATCHED`, and any case in `approval`, `authorization`, `safety`, or `trace_contract`. Those categories are always critical.
- **Never lower an expectation to absorb a regression.** Fix the behavior, or change the case's declared expectation with an explicit justification in its own reviewed change.
- **Check operational movement.** Large shifts in `performanceBaseline` deserve a sentence in the PR, even though those rules only warn.
- **Keep identities in step.** The dataset version, the baseline version, the policy pin, and the policy version move together.
