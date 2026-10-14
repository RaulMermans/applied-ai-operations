# Eval Analytics and CI Gates

Sprint 18 ([ADR-023](../decisions/ADR-023-eval-analytics-ci-gates-and-adapter-verification.md)) turns the [Evaluation Runtime](evaluation-runtime.md) into a deterministic quality-control system. Analytics, baselines, and gates live inside `@aao/evaluation` (`src/analytics/`, `src/gates/`). Contracts live in `@aao/contracts` (`eval-analytics.ts`), and the read-only filesystem host is the canonical `aao` CLI in `@aao/framework` (`packages/framework/src/cli/eval/`, since Sprint 19; Sprint 18's plain-ESM `packages/evaluation/cli/` was migrated there and deleted).

```text
Dataset (EvalDataset v2, pinned OFFLINE fixtures)
   ↓  verifyDatasetEvidence  ── mismatch → EVAL_FIXTURE_FINGERPRINT_MISMATCH (nothing evaluated)
Eval Runtime (runEvalDataset, registered deterministic graders)
   ↓
EvalResults
   ↓  caseExpectationVerdict
Case Expectation Verdicts (MATCHED / MISMATCHED / ERROR)
   ↓  buildEvalSuiteReport
Suite Report (EvalSuiteReport v1)
   ↓  compareEvalSuites ← approved baseline (EvalBaseline v1, evals/baselines/)
Baseline Comparison (EvalComparisonReport v1)
   ↓  evaluateEvalGate ← gate policy (EvalGatePolicy v1, evals/gates/)
Gate Decision (EvalGateDecision v1)
   ↓
PASS / WARN / FAIL  →  exit code of `pnpm eval:ci`
```

The only effect of a gate is the exit code of a developer or CI command. A decision is not a Run status, and no execution package reads one.

## Identity layers

| Identity | Covers | Use |
| --- | --- | --- |
| `resultId` (`evr.`) | One evaluation of one exact evidence | Observation identity (Sprint 17) |
| `evidenceFingerprint` | The exact evidence evaluated | Fixture pinning, provenance |
| `comparisonKey` (`evk.`) | `evalRef`, `graderRef`, `datasetRef`, `caseId`, `mode`, `targetType` | Matching a case across runs |
| `semanticVerdictFingerprint` (`evs.`) | Comparison key + status, error code, score, sorted assertion outcomes | "Same judgment?" across providers and Runs |

The comparison key excludes Run id, Trace id, provider, model, result id, and evidence fingerprint. The same portability case evaluated over provider A and provider B evidence has two evidence fingerprints, two result ids, one comparison key, and one semantic verdict fingerprint.

## Case expectations

`EvalResult.status` is the evaluator's judgment of the system. The case expectation verdict says whether the *case* behaved as declared:

| Expected | Actual | Verdict |
| --- | --- | --- |
| `failed` `[APPROVAL_BYPASSED]` | `failed` `[APPROVAL_BYPASSED]` | `MATCHED` |
| `failed` `[APPROVAL_BYPASSED]` | `failed` `[APPROVAL_NOT_REQUESTED]` | `MISMATCHED` |
| `error` `EVAL_REQUIRED_EVIDENCE_INCOMPLETE` | `error` `EVAL_REQUIRED_EVIDENCE_INCOMPLETE` | `MATCHED` |
| `error` `EVAL_EVIDENCE_MISSING` | `error` `EVAL_REQUIRED_EVIDENCE_INCOMPLETE` | `ERROR` |
| `passed` | `error` (any) | `ERROR` |
| `error` (any) | `passed` | `MISMATCHED` |

Failed reason codes are the sorted, unique reason codes of the failed assertions.

## Suite report

`EvalSuiteReport` holds:

- `datasetRef` and one entry per executed case: `caseId`, `comparisonKey`, `identity`, `categories` (from the definition), `expected`, `actual` (`status`, `errorCode?`, `reasonCodes`, `score?`), `expectation`, and `semanticVerdictFingerprint`.
- `summary`: `casesTotal`, `expectationsMatched`, `expectationsMismatched`, `expectationErrors`, `expectationMatchRate`, `rawStatuses { passed, failed, error }`, and `averageScore` (a measurement).
- `categoryBreakdown`, plus `criticalFindings`: unmatched cases in a canonical critical category.
- `operational?`: advisory measurements projected from the canonical `AggregateMetrics` of the evaluated evidence. The host aggregates them with `@aao/observability`; Evaluation never derives Metrics.
- `semanticFingerprint`: covers keys, expectations, and semantic verdicts only.
- `metadata?`: `generatedAt`, `gitSha`, `releaseId`, `environment`. Metadata never affects a fingerprint or a verdict.

A measurement is `{ status: "complete", value }`, `{ status: "partial" }`, or `{ status: "unavailable" }`; it is never a guessed number. Latency percentiles cover terminal Runs. A Run still waiting has no duration (it is ineligible, not missing), but a terminal Run without a duration makes latency `partial`.

### Report integrity (Sprint 19)

A schema-valid report could still *self-attest*: claim `summary.expectationsMatched: 35` while its cases say otherwise. `validateEvalSuiteReportIntegrity(report)` recomputes, from the report's own case data, every comparison key, canonical category order, and case expectation verdict (`expectationOfVerdict`, the same rule `caseExpectationVerdict` uses), plus the summary counts and match rate, the category breakdown, the critical findings, and the suite semantic fingerprint. Any disagreement is `EVAL_SUITE_REPORT_INCONSISTENT` with at most 20 bounded issues. Per-case semantic verdict fingerprints cover assertion-level detail a report does not carry, so they are not re-derivable; `operational` is advisory and is not re-derived either. `validateEvalBaselineIntegrity` applies the same checks to a baseline's case expectations, `suiteSummary`, and `generatedFrom` fingerprint.

Every public path that accepts a caller-supplied report enforces it: `evaluateEvalGate` (candidate → gate error `EVAL_SUITE_REPORT_INCONSISTENT`; a self-inconsistent baseline → `EVAL_BASELINE_INVALID` even when re-pinned), `compareEvalSuites`, `proposeEvalBaseline` (a proposal never launders a forged summary into a baseline), and `analyzeEvalSuites`. The check is proof-layer only: it never grants, approves, executes, or changes Runtime or Governance state. No `@aao/framework` API accepts a caller-supplied report.

`analyzeEvalSuites(reports[])` aggregates compatible reports (same dataset version) into case stability, regression frequency, error frequency, and mean score. There is no store and no time series.

## Comparison

`compareEvalSuites({ baseline, candidate })` classifies every case slot once:

| Classification | Meaning |
| --- | --- |
| `UNCHANGED_MATCH` / `UNCHANGED_MISMATCH` | Comparable; same expectation outcome |
| `REGRESSION` | Baseline matched, candidate does not |
| `IMPROVEMENT` | Baseline did not match, candidate does |
| `NEW_CASE` | Only the candidate has it |
| `MISSING_CASE` | The approved baseline has it; the candidate did not execute it |
| `INCOMPATIBLE` | Same slot, different Eval, grader, or dataset version, mode, or target |

- A regression is defined on expectations, never on raw status: two `failed` results can be a regression.
- A version change is `INCOMPATIBLE` unless a dataset version is explicitly declared compatible.
- Scores are compared only for comparable slots.
- `RegressionFinding`s list regressions, missing, incompatible, unmatched new, and persisting mismatched cases, with severity (`critical`/`required`) and codes. They are review candidates only: nothing promotes them into a dataset, baseline, Skill, or Memory.

## Gate policy

`evals/gates/foundation-ci.v1.yaml` (`foundation-ci@1.0.0`):

```yaml
datasetRef: { id: aao.runtime-foundation, version: "2.0.0" }
baselineRef: { id: runtime-foundation, version: "1.0.0", fingerprint: <sha256> }
hardFail:
  requireAllCasesPresent: true
  requireExpectationMatchRate: 1.0
  maxRegressions: 0
  criticalCategories: [approval, authorization, safety, trace_contract]
warnings:
  - { id: latency-p95, metric: runDurationP95Ms, maxRegressionPercent: 20, severity: advisory }
  - { id: known-cost, metric: knownEstimatedCostNanos, maxRegressionPercent: 15, severity: advisory }
  - { id: retrying-run-rate, metric: retryingRunRate, maxRegressionPercent: 15, severity: advisory }
```

- **Strict data.** Unknown keys, code-bearing keys (`modulePath`, `shellCommand`, `script`, …), YAML custom tags, more than 16 metric rules, duplicate rule ids, and policies over 16 KiB are rejected (`EVAL_GATE_POLICY_INVALID`).
- **Critical categories are a floor.** `approval`, `authorization`, `safety`, and `trace_contract` cannot be removed, and a critical case missing from the candidate always fails.
- **Severity.** `critical` (categories) and `required` (every other case: match rate, regressions, missing cases, errors) hard-fail. `advisory` metric rules warn.
- **Missing evidence never passes.** `onMissingEvidence` defaults to `warn` for advisory rules and `fail` for required ones. A required rule cannot be set to `warn`.
- **Versioning.** Changing a threshold, category, dataset, baseline pin, or missing-evidence behavior requires a new policy version.
- **Metric direction is fixed.** Duration, cost, tokens, retries, and Tool calls regress upward; `averageScore` regresses downward. A zero baseline with any worsening is unbounded and always over the threshold.

The foundation policy has no `averageScore` rule because the foundation dataset has no scored evaluations; such a rule could only report missing evidence. Its modelled-cost rule uses the *known* cost, because the foundation deliberately contains an unpriced Run.

## Gate decision and errors

`EvalGateDecision` holds:

- `passed` (exactly when there is no hard failure) and a derived `outcome` (`PASS`/`WARN`/`FAIL`);
- `hardFailures [{ code, rule, caseIds?, metric? }]` and `warnings [{ code, ruleId, metric, baseline, candidate, changePercent }]`;
- the candidate summary, the comparison summary, findings, and optional metadata.

Hard-failure codes:

- `EVAL_GATE_CRITICAL_REGRESSION` and `EVAL_GATE_CRITICAL_MISMATCH`;
- `EVAL_COMPARISON_MISSING_CASE`;
- `EVAL_BASELINE_INCOMPATIBLE`;
- `EVAL_FIXTURE_FINGERPRINT_MISMATCH`;
- `EVAL_GATE_UNEXPECTED_ERROR`;
- `EVAL_GATE_EXPECTATION_MISMATCH` (match rate below the policy);
- `EVAL_GATE_REGRESSION_LIMIT`;
- `EVAL_GATE_METRIC_REGRESSION` and `EVAL_GATE_INCOMPLETE_EVIDENCE` (required metric rules).

A *gate error* means no trustworthy comparison happened. It is returned instead of a decision, is never reported as a regression, and exits 1 with `GATE ERROR`:

- `EVAL_GATE_POLICY_INVALID`;
- `EVAL_BASELINE_INVALID` (an invalid baseline, or content that does not match the policy pin);
- `EVAL_BASELINE_INCOMPATIBLE` (not the policy's dataset, and no compatibility rule applies);
- `EVAL_FIXTURE_FINGERPRINT_MISMATCH` (refused in preflight, before evaluation);
- `EVAL_GATE_INCOMPLETE_EVIDENCE` (pipeline inputs unusable);
- `EVAL_SUITE_REPORT_INCONSISTENT` (the candidate report's derived fields disagree with its own cases).

## Commands

| Command | Does |
| --- | --- |
| `aao eval ci [--format json] [--verbose] [--git-sha <sha>]` (alias `pnpm eval:ci`) | Full gate pipeline. Exit 0 = PASS or WARN; 1 = hard failure or gate error |
| `aao eval adapters [--format json]` (alias `pnpm eval:adapters`) | [Adapter verification](adapter-verification.md) |
| `aao eval baseline propose --id <id> --version <v>` (alias `pnpm eval:baseline:propose`) | Print a baseline *proposal*; writes nothing |

Since Sprint 19 these are the canonical TypeScript `aao` CLI ([CLI](../framework/cli.md)). The `pnpm eval:*` aliases build `@aao/framework` and its dependency closure first, so no prior `pnpm build` is needed and stale `dist/` is never run. Output is byte-identical to the Sprint 18 commands. They are offline: a guard refuses `fetch`, socket connections, and DNS lookups, and exits 1 if any is attempted. `pnpm check` and GitHub CI run `eval:ci` and `eval:adapters` after the tests. The model judge is never part of these commands.

Default text output:

```text
AAO Eval Gate

Policy: foundation-ci@1.0.0
Dataset: aao.runtime-foundation@2.0.0
Baseline: runtime-foundation@1.0.0
Cases: 35/35 matched
Regressions: 0
Missing: 0  New: 0  Incompatible: 0
Critical failures: 0
Warnings: 0

PASS
```

## Privacy and determinism

- **Privacy.** Reports, baselines, decisions, and findings carry identifiers, codes, statuses, counts, scores, measurements, and fingerprints only. They contain no Tool input or output, prompts, model output, state values, Approval subjects, credentials, evidence references, or Run ids.
- **Determinism.** The same dataset, fixtures, definitions, grader versions, baseline, and policy give deep-equal suite reports, comparisons, and decisions, and byte-identical CLI output. No semantic field depends on a clock or randomness.

## Not here

There are no dashboards, Eval database or warehouse, automatic baseline updates, automatic regression promotion, model-judge merge gates, live provider benchmarking, or Runtime gating.
