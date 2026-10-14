# ADR-023: Eval analytics, CI gates, and adapter verification

Status: accepted

## Context

Sprint 17 ([ADR-022](ADR-022-evaluation-runtime-and-portable-verification.md)) gave AAO an Evaluation Runtime: versioned definitions, datasets, deterministic graders, and reproducible `EvalResult`s. It could judge one evidence bundle, but AAO still could not answer three engineering questions:

- Is this candidate *as good as the state we accepted*?
- Should this change be allowed to merge?
- Does a substrate (a model SDK, an MCP server, a local handler) preserve AAO semantics when its behavior is mapped into AAO evidence?

Three traps shape the decision:

- `resultId` is unique to the specific evidence evaluated. Using it as a comparison key would make every Run look new.
- Sprint 17 deliberately includes cases that *expect* `failed` or `error`. A gate that equates `EvalResult.failed` with "the case failed" would break CI on exactly the cases that prove the evaluator works.
- Sprint 17 datasets referenced fixtures without pinning them, so a fixture could change under a case without anyone noticing.

Sprint 17 also left one semantic defect: the Approval grader bound guarded Tools to the *first* approved Approval anywhere in a Run. That is fixed first, as a separate closure (grader 2.0.0, `guardApprovalNodeId`; see [ADR-022's amendment](ADR-022-evaluation-runtime-and-portable-verification.md#amendment-approval-guard-nodes-sprint-17-closure)).

## Decision

### Identity

- **`resultId` is observation identity, not comparison identity.** It stays unique to the evidence evaluated.
- **An explicit comparison key exists.** `buildEvalComparisonKey(result)` is `evk.` + SHA-256 over the canonical logical identity: `evalRef` (id, version), `graderRef` (id, version), `datasetRef` (id, version), `caseId`, `mode`, and `targetType`. Run id, Trace id, provider, model, result id, and evidence fingerprint are excluded. The same case evaluated on any day, provider, or Run has one key.
- **A semantic verdict fingerprint exists.** `semanticVerdictFingerprint(result)` is `evs.` + SHA-256 over the comparison key and the normalized judgment: status, error code, score, and each assertion's id, status, score, and reason code, sorted by id. Evidence references and every execution identity are excluded. Provider A and provider B producing the same canonical AAO behavior share it.
- **`evidenceFingerprint` keeps its Sprint 17 meaning:** the exact evidence evaluated. It may differ where the semantic verdict fingerprint is equal, and the two are never collapsed.

### Case expectations

- **The case expectation verdict is not `EvalResult.status`.** Each case yields `MATCHED`, `MISMATCHED` (a trustworthy judgment that differs from the expectation), or `ERROR` (the evaluator could not judge, and the case did not expect exactly that error).
- **Negative and deliberate-error cases are successful regression cases.** A case expecting `failed` with `[APPROVAL_BYPASSED]` that gets exactly that is `MATCHED`. A case expecting `error` with `EVAL_REQUIRED_EVIDENCE_INCOMPLETE` that gets exactly that is `MATCHED`. An unexpected error code never matches.

### Datasets and baselines

- **`EvalDataset` is migrated to schema version 2.** Expectations are required and exact: `failed` names its sorted reason codes, and `error` names its error code. Schema version 1 is refused with a migration message, never reinterpreted. The foundation dataset moved from `aao.runtime-foundation@1.1.0` to `@2.0.0` with the same 35 cases.
- **OFFLINE fixtures are fingerprint-pinned.** Every OFFLINE case pins the `evidenceFingerprint` of its evidence. A mismatch is `EVAL_FIXTURE_FINGERPRINT_MISMATCH`: that case reaches no grader, and the CI host refuses to run at all. Nothing rewrites a pin; re-pinning is a reviewed dataset change with a new dataset version. RUNTIME evidence is never pinned, because live evidence differs per execution.
- **A baseline is approved evidence for comparison, never execution policy.** `EvalBaseline` (schema version 1) lives under `evals/baselines/`. It is version-controlled, reviewable, and JSON-safe.
- **Baseline changes are explicit and human-reviewed.** `pnpm eval:baseline:propose` prints a proposal and writes nothing. CI reads the baseline and never writes it. There is no accept-everything path, and a regression never becomes the new baseline automatically.
- **Baselines are immutable within a version.** The gate policy pins `baselineRef { id, version, fingerprint }`, so an edited baseline file is `EVAL_BASELINE_INVALID` until a reviewed change re-pins it.

### Comparison

- **Comparison versions must be compatible.** Cases are matched by slot (dataset id + case id). If the comparison identity differs (Eval, grader, or dataset version, mode, target), the case is `INCOMPATIBLE`, never a regression.
- A different dataset version is compared only when the policy explicitly lists it (`comparison.compatibleBaselineDatasetVersions`). Otherwise the gate reports a configuration error and no trustworthy comparison happens.
- **Classification is by case expectation:**
  - `UNCHANGED_MATCH` and `UNCHANGED_MISMATCH`: the outcome did not change.
  - `REGRESSION`: the case went from matched to not matched, even when both results are `failed`.
  - `IMPROVEMENT`: the case went from not matched to matched.
  - `NEW_CASE` and `MISSING_CASE`: the case exists on only one side.
  - `INCOMPATIBLE`: see above.
- Scores are compared only for comparable cases.

### The gate

- **Hard gate failures are deterministic.** `EvalGatePolicy` (schema version 1) is strict, versioned, bounded data with no code. `evaluateEvalGate` is pure code: no model decides that a regression is acceptable, and identical inputs give a deep-equal `EvalGateDecision`.
- **Critical Approval, Authorization, and Trace regressions always hard-fail.** `approval`, `authorization`, `safety`, and `trace_contract` are always critical. A policy may add categories but never remove these, and there is no warn mode for them. A critical case missing from the candidate always fails.
- **Other hard failures:**
  - an expectation match rate below the policy;
  - regressions above the policy;
  - a missing required case;
  - an incompatible case;
  - a fixture integrity failure;
  - an unexpected Eval error (infrastructure inability is never success);
  - a `required` metric rule that regressed or lacks evidence.
- **Performance regressions initially warn.** Advisory rules cover p95 duration, known modelled cost, retrying-Run rate, tokens, Tool calls, and mean score. Their thresholds live in the versioned policy, not in code.
- **Missing required evidence cannot pass.** A measurement is a number only when complete. Partial or unavailable evidence warns (`onMissingEvidence: warn`, the advisory default) or fails (`fail`, the required default). A required rule cannot be downgraded to warn.
- **The CI gate is offline and deterministic by default.**
  - `pnpm eval:ci` runs after the build. It exits 0 on PASS or WARN, 1 on a hard failure, and 1 on a configuration or infrastructure error. Errors carry a distinct `GATE ERROR` diagnostic and never use regression wording.
  - It needs no keys, OAuth, provider, MCP remote server, or network, and a guard refuses any connection attempt.
  - Output is compact text, or JSON with no ANSI.
  - Release metadata (`--git-sha`) is host-supplied and never affects a key, fingerprint, or verdict. Analytics never shell out to Git.
- **The model judge is excluded from the mandatory merge gate.** Probabilistic judgments may later run as optional, scheduled, or benchmark evaluations with statistical policies.

### Adapter verification

- **Adapter verification reuses canonical EvalDefinitions.** It is a use of the Evaluation Runtime (definitions, registry, datasets, case-expectation semantics), not a second assertion engine. One canonical grader was added because no existing grader judged it: `aao.model-call` covers trusted model identity, usage, outcome, and normalized failure.
- **Adapter-specific drivers produce canonical evidence.**
  - Each driver lives with its substrate: `packages/<substrate>/conformance/`.
  - A driver turns a canonical scenario into canonical AAO evidence by running a real compiled AAO workflow.
  - The verification host injects the canonical recorders.
  - Drivers never import `@aao/evaluation`, the verifier never introspects framework internals, and there is no discovery or dynamic import.
- **Adapter support may be partial.**
  - A driver declares each scenario of its own kind `SUPPORTED`, `UNSUPPORTED`, or `NOT_APPLICABLE`. Model, Tool, and orchestration adapters stay distinct kinds.
  - A `SUPPORTED` scenario that fails is a CI failure (`ADAPTER_CONFORMANCE_FAILED`). An unsupported scenario is reported, never passed.
  - Semantic conformance means the adapter reaches the same semantic verdict fingerprint as the native AAO reference on every shared case. It does not mean byte-equal Traces.
- **The public `AdapterManifest`, capability matrix, and adapter API remain deferred to Sprint 20.** The conformance report is internal and makes no public compatibility promise.

### Authority

- **Evaluation and the gate remain non-authoritative.** A gate decision is not a Run status, and nothing in execution reads a decision, baseline, policy, finding, or conformance report. None of these can approve, authorize, trigger a Tool, change a Run, mark replay safe, change retries, grant a Role, become Memory, modify a Skill, or modify a dataset. The only effect of a gate is the exit code of a developer or CI command.
- **No Runtime permission changes.** `external_side_effect`, `destructive`, and `sensitive_data` remain unsupported.

## Consequences

- The merge gate is one command over version-controlled assets. A behavioral regression in a critical area cannot merge, and an intentional behavior change requires a reviewed dataset or baseline change, visible in the diff.
- Changing a fixture requires deliberately re-pinning it. Changing a definition or grader version requires a new baseline, because otherwise comparisons are incompatible.
- `RegressionFinding`s are review candidates only. Promoting one into a dataset case stays a human repository change.
- Adapter verification gives Sprint 20 an evidence base:
  - The native Tool and MCP connector paths, and the native model and Vercel AI SDK paths, agree semantically on every shared case.
  - The MCP connector truthfully does not support Runtime retries (it declares no retry safety).
  - A native model adapter cannot express a tool-call response.
  - No adapter can propagate cancellation to a provider, because the ModelAdapter port has no abort signal.
- LangGraph remains a Sprint 0A research spike (`packages/substrate-spikes`) with no maintained AAO adapter. It is DEFERRED, not claimed.

## Not decided here

- The public Adapter and Portability contract (Sprint 20) and the framework surface (Sprint 19).
- Model-judge gating policies (repeated runs, statistical thresholds), live provider benchmarking, an Eval database, dashboards, and time-series history.
- Automatic regression promotion, Memory or Skill promotion, and any side-effect enablement.

See [eval-analytics-ci.md](../architecture/eval-analytics-ci.md), [adapter-verification.md](../architecture/adapter-verification.md), and [`evals/baselines/README.md`](../../evals/baselines/README.md).
