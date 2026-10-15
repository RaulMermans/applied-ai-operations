# Evaluation Runtime

`@aao/evaluation` (Sprint 17, [ADR-022](../decisions/ADR-022-evaluation-runtime-and-portable-verification.md)) turns AAO execution evidence into reproducible verdicts. It observes and judges; it never becomes execution authority.

## Architecture

```text
                 AAO EXECUTION
                      │
       ┌──────────────┼──────────────┐
     Trace          Metrics         Audit        (+ Runtime execution state, explicit subject)
       └──────────────┼──────────────┘
                      ▼
            EvalEvidenceBundle  (deep-frozen copy, fingerprinted)
                      │
                      ▼
               EvalDefinition v2 ──► Evaluator Registry (exact grader id + version)
                      │                     │
          ┌───────────┴───────────┐         │
  Deterministic grader      Bounded model judge (optional, injected port)
       DEFAULT                    │
          └───────────┬───────────┘
                      ▼
                 EvalResult v2  (references evidence, never copies it)
```

### Authority

```text
Execution  ──►  Evaluation          (evidence flows one way)

Evaluation ──✕─► Execution authority (no Approval, Authorization, Governance,
                                       Run state, Tool, retry, recovery, routing)
```

No execution package depends on `@aao/evaluation`. There is no `RuntimeOptions.eval` and no evaluator inside the Runtime loop. Evaluation writes no Trace, Audit, or Metrics. A passing result, including a model judge that "says" to approve, changes nothing.

### Portability

```text
LangGraph ──┐
MCP ────────┤
AI SDK ─────┤──► adapters normalize into ──► AAO canonical evidence ──► same EvalDefinition ──► same verdict
Local ──────┘                               (Trace, ToolRef, Run status, state, Metrics, Audit)
```

Evaluation policies attach to AAO contracts and execution semantics, not to individual model, Tool, or orchestration frameworks. This is a permanent invariant.

## Modes

| Mode | Evidence | `origin` |
| --- | --- | --- |
| `OFFLINE` | Committed fixtures, recorded regression Traces, synthetic boundary cases, prior Runs, benchmark datasets. No live execution. | `recorded` |
| `RUNTIME` | A real, current AAO Run, handed over by the host after the Runtime returned at a terminal or safe boundary. Read-only. | `live_run` |

The same grader implementation serves both modes. A mode accepts only its own origin, and `RUNTIME` requires a Run identity.

## Contracts (`@aao/contracts`, `evaluation.ts`)

- **`EvalDefinition` v2** has these fields: `id`, `version`, `name`, `description?`, `categories?`, `supportedModes[]` (unique), `targetType`, `graderRef { id, version }`, and `config` (JSON-safe, ≤ 16 KiB, no code-bearing keys). Target types are `run`, `node`, `tool_use`, `artifact`, `trajectory`, `authorization`, `approval`, and `state`. Categories are `capability`, `regression`, `tool_use`, `safety`, `output_quality`, `model_benchmark`, `trace_contract`, `approval`, and `trajectory`; they describe and never grade.
- **`EvalResult` v2** has these fields: `resultId`, `evalRef`, `graderRef`, `datasetRef?` + `caseId?`, `mode`, `targetType`, `runId?`, `traceId?`, `evidenceFingerprint`, `status`, `score?` (0–1, optional), `errorCode?` (exactly when `error`), `assertions[]` (≤ 64), and `evidenceRefs[]` (≤ 32). Each assertion has `id`, `status`, `score?`, `reasonCode?`, and `evidenceRefs` (≤ 16).
- **`EvalDataset` v2 / `EvalCase`** (Sprint 18; v1 is refused, never reinterpreted) hold ordered, uniquely identified cases (≤ 200). Each case has an `evalRef`, a `mode`, an opaque `evidenceRef`, an `evidenceFingerprint` (exactly for OFFLINE cases), and a required, exact `expected` verdict: `failed` names its sorted `reasonCodes`, and `error` names its `errorCode`. **`EvalDatasetRun`** holds ordered case results with `matchesExpectation` (case expectation verdict `MATCHED`).
- **Error codes:** `EVAL_DEFINITION_NOT_FOUND`, `EVAL_GRADER_NOT_FOUND`, `EVAL_GRADER_VERSION_MISMATCH`, `EVAL_INVALID_DEFINITION`, `EVAL_MODE_UNSUPPORTED`, `EVAL_TARGET_UNSUPPORTED`, `EVAL_EVIDENCE_MISSING`, `EVAL_EVIDENCE_INVALID`, `EVAL_REQUIRED_EVIDENCE_INCOMPLETE`, `EVAL_GRADER_ERROR`, `EVAL_MODEL_JUDGE_ERROR`, `EVAL_DATASET_INVALID`, `EVAL_CASE_ERROR`, and (Sprint 18) `EVAL_FIXTURE_FINGERPRINT_MISMATCH`. Runtime failure codes are never reused.

## Evidence

`EvalEvidenceBundle` is the single evidence boundary:

| Field | Contents |
| --- | --- |
| `origin` | `live_run` or `recorded` |
| `source?` | An opaque reference |
| `runId?` | The Run identity |
| `trace?` | `TraceEvent[]` |
| `execution?` | A structural view a `RuntimeExecutionState` satisfies |
| `metrics?` | `RunMetrics` |
| `audit?` | `AuditEvent[]` |
| `subject?` | `{ id, content ≤ 16 KiB, context? ≤ 4 KiB }`, for model judges only |

The runner checks the evidence before any grader sees it:

- It must be JSON-safe, schema-valid, and identity-coherent: every part must name the same Run and Trace, otherwise the result is `EVAL_EVIDENCE_INVALID`.
- It is deep-copied and deep-frozen, so graders cannot mutate host objects.
- It is fingerprinted with SHA-256 over canonical JSON.

Graders validate what they read with the canonical validators:

- Trace with `validateTrace` (a corrupt Trace is `EVAL_EVIDENCE_INVALID`, except in the trace-contract grader, where validity *is* the criterion).
- Metrics with `RunMetricsSchema`.
- Audit with `AuditEventSchema` and `validateAuditStream`.

### Missing evidence never passes

| Situation | Status |
| --- | --- |
| Evidence absent | `error` `EVAL_EVIDENCE_MISSING` |
| Evidence corrupt, from mixed Runs, or not JSON | `error` `EVAL_EVIDENCE_INVALID` |
| Whole Run needed but no terminal event; Metrics `partial`/`unavailable`/`null`; partial trace quality | `error` `EVAL_REQUIRED_EVIDENCE_INCOMPLETE` |
| Conditional rule whose trigger is absent (no rejection, denial, or failure of that category) | `error` `EVAL_EVIDENCE_MISSING` |
| Obligation a complete Trace proves unmet (Approval required but never requested; expected block never happened) | `failed` |
| Criterion violated (forbidden Tool started, Tool after rejection, retry after denial) | `failed` |

## Runner

`evaluate({ definition, mode, evidence, registry, datasetRef?, caseId? })` runs these steps in order:

1. Definition identity. If it cannot be identified, `EvalInputError` is thrown.
2. Definition mode support.
3. Exact grader lookup.
4. Grader mode and target support.
5. Grader config validation.
6. Evidence checks and mode/origin binding.
7. The grader call, with exceptions contained as `EVAL_GRADER_ERROR` (no stack or message kept).
8. Assembly of a bounded `EvalResult`, validated against the schema.

Status is `passed` exactly when every assertion passed. A grader that returns an out-of-contract verdict produces a grader error, never `failed`.

`runEvalDataset({ dataset, definitions, registry, evidenceResolver })` works as follows:

- It validates the dataset, definitions, case refs, and case modes before anything runs (`EVAL_DATASET_INVALID`).
- It runs cases sequentially in dataset order.
- It isolates each case: unresolvable evidence is `EVAL_EVIDENCE_MISSING`, a throwing resolver is `EVAL_CASE_ERROR`, and OFFLINE evidence whose fingerprint differs from the case pin is `EVAL_FIXTURE_FINGERPRINT_MISMATCH` and reaches no grader. `verifyDatasetEvidence` checks every pin up front without evaluating anything.

Evidence is resolved only through the injected `EvidenceResolver`. `createStaticEvidenceResolver` maps exact references to host-supplied bundles; Evaluation never reads files or the network.

## Graders (OFFLINE + RUNTIME; `1.0.0` unless noted)

| Grader | Targets | Judges |
| --- | --- | --- |
| `aao.trace-contract` | run, trajectory | `validateTrace` validity, exactly one terminal event, optional `compareTraceWithExecution` |
| `aao.run-outcome` | run | Expected or forbidden status (Runtime state is truth; disagreement with Trace is `error`); failure code and category |
| `aao.trajectory` | trajectory, node, run | Node sequence (`exact` or `ordered_subsequence`, one entry per executed step); ordered event-pattern subsequence; forbidden Nodes and events. Patterns are canonical event types and Node ids, never regex over JSON |
| `aao.tool-usage` | tool_use | Required Tools (`tool.call.started`); forbidden Tools (started is `failed`; blocked-only passes and is cited); physical (handler starts) vs logical (distinct `toolExecutionId`) limits; first-invocation order; expected block (blocked and never started); expected failure |
| `aao.approval-compliance` **2.0.0** | approval | Approval required, or must not occur; request count; resolution; no guarded Tool before its guard Approval was approved (bypass); no guarded Tool after its guard Approval was rejected; Audit cross-check. Tool checks require `guardApprovalNodeId` (see below) |
| `aao.authorization-compliance` | authorization | Expected denials; every recorded denial has zero handler starts; every start has an Audit `tool.access.allowed` and no Audit denial was followed by a start. It never re-runs Authorization or interprets roles |
| `aao.retry-behavior` | run, node | Exact or maximum retries, no retry for named categories (needs such a failure), exhaustion expected or not. Always needs the whole Run |
| `aao.state-assertion` | state | `revision_equals`, `path_exists`, `path_not_exists`, `path_equals` (RFC 6901 JSON Pointer). Values are compared and never reported |
| `aao.metrics-threshold` | run | Max duration, approval wait, retries, failed attempts, physical and logical Tool calls, tokens, modelled cost. Incomplete measurement is `error` |
| `aao.model-call` (Sprint 18) | run, node | Model invocation count, trusted registered identity, exact token usage, outcome, normalized failure (`code`, `adapterReason`). Judges canonical model Trace only; used by adapter verification |

### Approval guard Nodes (Sprint 17 closure)

`aao.approval-compliance` 1.0.0 treated the *first* approved (or first non-approved) Approval anywhere in the Run as the one governing every Tool. In a workflow with two Approval boundaries, an unrelated earlier approval could vouch for a Tool whose own guard was still pending, and an unrelated rejection could falsely fail a Tool its guard approved.

2.0.0 binds Tool checks to an explicit guard:

```yaml
graderRef: { id: aao.approval-compliance, version: "2.0.0" }
config:
  approvalRequired: true
  guardApprovalNodeId: approve-crm-update
  guardedTools: [{ id: crm.update-draft, version: "1.0.0" }]
  noToolBeforeApproval: true
```

- `noToolBeforeApproval` and `noToolAfterNonApproval` require `guardApprovalNodeId`, and a guard requires one of them.
- Correlation uses canonical identity only: the `approval.requested` envelope `nodeId` → `approvalId` → `approval.resolved`. There is no "first", "nearest", or global Approval.
- A guarded Tool start is authorized only when the guard Node's governing Approval (its latest request before the start) was approved before the start. Otherwise the result is `failed` with `APPROVAL_BYPASSED`.
- `noToolAfterNonApproval` is triggered only by a rejected, expired, or cancelled *guard* Approval. A rejection at another Node is not the trigger, so the rule is `error` `EVAL_EVIDENCE_MISSING`, never a vacuous pass and never a false failure.
- `approvalRequired`, `expectedRequestCount`, `expectedResolution`, and `crossCheckAudit` still consider every Approval in the Run.
- 1.0.0 is retired, not reinterpreted. A definition that still names it resolves to `EVAL_GRADER_VERSION_MISMATCH`. The foundation Approval definitions moved to version 2.0.0.

### Tool arguments

Trace intentionally excludes Tool arguments and output. Schema validity needs no grader: Tool Runtime validates input before a handler runs, so `tool.call.started` already implies schema-valid input. Semantic argument quality needs explicit host-supplied evidence. It is deferred, and it is never inferred from Trace.

## Model judge (optional)

`createModelJudgeGrader({ judge: ModelJudgePort, timeoutMs? })` registers `aao.model-judge` only when the host supplies a port. The default registry needs no model.

- **Input:** the definition's rubric (criteria ≤ 2000 characters, ≤ 8 dimensions) and the explicit subject. Nothing else is sent.
- **Call:** exactly one per evaluation, with no retry and no recursion. The timeout defaults to 30 s and is capped at 120 s.
- **Output:** strict `{ passed, score, dimensionScores?, defects?, confidence? }`. A reasoning field, any unknown field, an out-of-range score, or an unknown dimension is `EVAL_MODEL_JUDGE_ERROR`, as are adapter exceptions and timeouts.
- **Verdict:** `passed` and `score ≥ passThreshold`, and every dimension with a `minScore` meets it.
- **Privacy:** the result keeps the score and assertion statuses only. The subject, context, rubric text, and defect codes are never persisted.
- **Scope:** the judge supports the `artifact`, `run`, `node`, and `trajectory` targets only. Permission, Approval, Tool-authorization, and state compliance stay deterministic.

## Determinism

Deterministic graders use no clock and no randomness. The same definition, grader version, evidence, mode, and dataset/case identity produce deep-equal results:

- `evidenceFingerprint` excludes the `source` pointer and `origin`.
- `resultId` includes the mode, so the same evidence judged OFFLINE and RUNTIME has one fingerprint and two result ids.
- Equivalent evidence from different Runs or providers yields the same verdict and assertions with different ids, because provider metadata and Run identity are part of the evidence.

## Datasets

The datasets, definitions, and fixtures live in [`evals/`](../../evals/README.md):

- `evals/definitions/runtime-foundation.v1.yaml` holds 22 definitions. The adapter conformance definitions (18 since Sprint 20) moved into `@aao/adapters` as the canonical conformance suite ([ADR-025](../decisions/ADR-025-adapter-and-portability-contract.md)).
- `evals/datasets/runtime-foundation.v2.yaml` (`aao.runtime-foundation@2.0.0`, schema 2) holds 35 fixture-pinned cases: desired behavior, forbidden behavior, deliberate evaluator-error cases, and the multi-Approval guard regressions.
- `evals/fixtures/` holds the evidence, regenerated deterministically by tests from real Runs and recorder-validated synthetic Traces.

## Sprint 18: analytics, CI gates, adapter verification

Sprint 18 builds on this runtime without changing its authority ([ADR-023](../decisions/ADR-023-eval-analytics-ci-gates-and-adapter-verification.md)):

- **Comparison identity.** `resultId` stays observation identity. `buildEvalComparisonKey` (Eval, grader, dataset, case, mode, target) is the logical identity used for comparison, and `semanticVerdictFingerprint` is the normalized judgment. `evidenceFingerprint` keeps its meaning.
- **Fixture pinning.** OFFLINE dataset cases pin their evidence fingerprint (dataset schema 2).
- **CI semantics.** A case's expectation verdict, not raw status, decides CI: negative (`failed`) and deliberate-error cases that behave exactly as expected are `MATCHED`. Suite reports, baseline comparison, and the deterministic gate are described in [eval-analytics-ci.md](eval-analytics-ci.md).
- **Adapter verification.** Substrate test drivers produce canonical evidence that these same definitions and graders judge. See [adapter-verification.md](adapter-verification.md).

## Not in Sprint 17 or 18

These are still not built:

- An Eval store, result database, dashboards, or time-series history.
- The public Adapter contract (Sprint 20).
- Eval-driven Runtime gating or Trace/Audit mutation.
- Automatic regression creation, Reflexion or evaluator-optimizer loops, memory promotion, or Skill Runtime.
- A model/provider benchmark runner, or a model-judge merge gate.
- Side-effect enablement.
