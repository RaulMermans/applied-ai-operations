# ADR-022: Evaluation Runtime and portable verification

Status: accepted

## Context

Sprints 15–16 gave AAO execution evidence: Trace (chronology, [ADR-020](ADR-020-trace-runtime-and-observability-boundary.md)), Trace-derived Metrics, and Audit (accountability, [ADR-021](ADR-021-metrics-and-audit-boundaries.md)). AAO still could not turn that evidence into reproducible proof that a workflow *behaved correctly*. Examples: the required Tool ran, a forbidden Tool did not, an Approval was not bypassed, an Authorization denial was respected, and a permission failure was not retried.

Sprint 2 left two placeholder contracts, `EvalDefinition` and `EvalResult` (schema version 1). They had no grader reference, no config, no evidence identity, and no implementation.

Two risks dominate:

- Evaluation becoming execution authority (an Eval verdict gating a Run, approving an action, or widening permissions).
- Evaluation semantics being defined per framework or provider ("LangGraph eval", "MCP eval") instead of on AAO's own contracts.

## Decision

- **Evaluation is non-authoritative.** It observes and judges AAO execution evidence. An `EvalResult` never grants permission, approves an action, changes Run state, triggers a Tool, retries, alters routing, changes durability or recovery, modifies Governance, promotes memory, changes a Skill, or deploys, publishes, or sends anything.
  - No execution package depends on `@aao/evaluation`.
  - Nothing in AAO reads an `EvalResult` to make an execution decision.
  - Evaluation writes no Trace, Audit, or Metrics.
- **The Evaluation Runtime is its own layer, outside the Runtime.**
  - `@aao/evaluation` owns the Evaluator Registry, the evidence boundary, the runner, offline datasets, deterministic graders, and the optional model-judge port.
  - Its production dependencies are `@aao/contracts`, `@aao/observability` (only for the canonical validators `validateTrace` and `compareTraceWithExecution`, plus `validateAuditStream`), `yaml`, and `zod`.
  - Nothing is added to `@aao/runtime`, `@aao/observability`, or `@aao/model-runtime`.
- **OFFLINE and RUNTIME modes.**
  - `OFFLINE` judges recorded evidence: committed fixtures, regression Traces, synthetic boundary cases, and prior Runs.
  - `RUNTIME` judges evidence from a real, current Run at a terminal or safe boundary. The host hands it over after the Runtime returned.
  - Runtime mode does not mean Runtime-loop gating: there is no `RuntimeOptions.eval` and no evaluator inside the loop.
  - Evidence declares its `origin` (`live_run` or `recorded`), and a mode only accepts its own origin.
  - The same grader serves both modes with the same logic.
- **`EvalDefinition` is migrated to executable schema version 2:** `id`, `version`, `name`, `description?`, `categories?`, `supportedModes[]` (unique), `targetType`, `graderRef { id, version }` (exact semver), and `config` (JSON-safe, at most 16 KiB).
  - The Sprint 2 shape is rejected, and no second definition contract exists.
  - Target ("what") and grader ("how") stay separate. `approval` and `state` were added to the existing target types because the graders need them.
  - Categories are descriptive and never change grading.
  - Changing a material criterion requires a new definition version.
- **`EvalResult` is migrated to schema version 2:** `resultId`, `evalRef`, `graderRef`, `datasetRef?` + `caseId?`, `mode`, `targetType`, `runId?`, `traceId?`, `evidenceFingerprint`, `status`, `score?`, `errorCode?`, `assertions[]`, and `evidenceRefs[]`, all bounded.
  - `evidenceFingerprint` is SHA-256 over the canonical JSON of the evidence evaluated (Run id, Trace, execution, Metrics, Audit, subject). The `source` pointer and `origin` are excluded.
  - `resultId` is SHA-256 over eval, grader, mode, target, dataset/case, Run/Trace identity, and the fingerprint.
  - No timestamp participates. The same evaluation over identical evidence gives a deep-equal result.
- **`EvalDataset` (schema version 1) and `EvalCase` are versioned product assets.**
  - Each case has a stable, human-assigned id, an exact `evalRef`, a `mode`, an opaque `evidenceRef`, and an optional `expected { status, errorCode? }`.
  - Cases reference evidence and never embed it.
  - A dataset has unique ids, no duplicate content, and at most 200 cases.
  - Dataset runs are sequential and ordered by the dataset's case order. Each case is isolated: an unresolvable or throwing evidence lookup, or a grader defect, becomes that case's `error` result.
  - `EvalDatasetRun` holds ordered case results only, with no analytics.
- **Evaluators are trusted registered code.** The `EvaluatorRegistry` is constructible (no singleton) and populated by explicit registration only.
  - Lookup is exact on id and version; a duplicate registration is rejected.
  - There is no filesystem discovery and no dynamic import.
  - Each grader validates its own config before anything executes. Invalid config is `EVAL_INVALID_DEFINITION`.
- **Eval data cannot load code.** Definition config and dataset files reject code-bearing keys (`modulePath`, `javascript`, `functionBody`, `shellCommand`, `script`, `require`, `import`, `exec`, …) at any depth.
  - YAML is parsed with the core schema, strict and with unique keys. Any warning, such as an unknown `!!js/function` tag, rejects the file.
  - Evidence is resolved by an injected host `EvidenceResolver`; the Evaluation Runtime never reads files, fetches URIs, or uses the network.
- **Deterministic graders are the default.** Nine built-in graders, each addressing a real failure class:

  | Grader | Covers |
  | --- | --- |
  | `aao.trace-contract` | Reuses `validateTrace`; no second validator |
  | `aao.run-outcome` | Run status and failure code/category |
  | `aao.trajectory` | Node and event trajectory; `exact` vs `ordered_subsequence` is explicit |
  | `aao.tool-usage` | Required, forbidden, physical vs logical counts, order, blocked, failure |
  | `aao.approval-compliance` | Requested, count, resolution, no Tool before approval, no Tool after rejection |
  | `aao.authorization-compliance` | Recorded denials respected; Audit coherence |
  | `aao.retry-behavior` | Retries from `retry.scheduled` / `retry.exhausted` |
  | `aao.state-assertion` | JSON Pointer operators: revision, exists, not-exists, equals |
  | `aao.metrics-threshold` | Operational limits over `RunMetrics` |

  Graders receive a deep-frozen copy of the evidence; host objects are never mutated.
- **Model judges are optional and bounded.**
  - `ModelJudgePort` is provider-independent and host-injected. No model SDK is imported.
  - Each evaluation makes one call, with no retry, no recursion, and a hard timeout.
  - The judge receives only the definition's rubric and the host-selected bounded subject (at most 16 KiB of content plus 4 KiB of context). It never receives Trace, RunState, Audit, Tool payloads, or secrets.
  - Output is strict and structured: `passed`, `score`, and optionally `dimensionScores`, `defects` (codes), and `confidence`. A reasoning field or any unknown field is a judge error.
  - The judge grader does not support `authorization`, `approval`, `tool_use`, or `state` targets: deterministic graders stay authoritative for safety semantics.
- **Missing evidence never silently passes.**
  - Absent, corrupt, or identity-incoherent evidence is `error`.
  - A partial Trace where the whole Run is needed is `error`.
  - Incomplete Metrics (`partial` or `unavailable` cost or tokens, a `null` duration, `partial` trace quality) are `EVAL_REQUIRED_EVIDENCE_INCOMPLETE`.
  - A conditional rule whose triggering scenario is absent (no rejection, no denial, no failure of the named category) is `error`, never a vacuous pass.
  - An obligation that a complete Trace shows was not met (for example, an Approval was required but never requested) is `failed`.
- **Failed and error are distinct.** `failed` means trustworthy evidence violated a criterion. `error` means no trustworthy judgment was possible: invalid definition, missing, corrupt, or incomplete evidence, a grader exception (`EVAL_GRADER_ERROR`, with no stack or message kept), or a judge failure (`EVAL_MODEL_JUDGE_ERROR`).
- **Results reference evidence; they never copy it.**
  - Evidence references are opaque and bounded: `trace://<run>/event/<seq>`, `audit://…`, `execution://<run>/state-revision/<n>`, `metrics://<run>`, `subject://<id>`, `fixture://<name>`. There are at most 32 per result and 16 per assertion.
  - Results contain no prompts, model output, Tool input or output, state values, Approval subjects, credentials, or reasoning.
  - A state assertion reports `STATE_ASSERTION_FAILED`, never the value.
  - Judge subjects and defect codes are never persisted.
- **Evaluation targets AAO canonical semantics.** Definitions use AAO Trace event types, `ToolRef`s, Run status, failure categories, state paths, and `RunMetrics`. They never use LangGraph nodes, Vercel `generateText`, MCP JSON-RPC, or provider tool-call formats.
  - External evidence must first be normalized into AAO contracts by an adapter.
  - `@aao/evaluation` imports no LangGraph, LangChain, AI SDK, MCP, `@aao/mcp-connector`, `@aao/substrate-*`, OpenAI or Anthropic SDK, Langfuse, Phoenix, Promptfoo, or DeepEval code.
- **Portable verification is a permanent AAO invariant:** *evaluation policies attach to AAO contracts and execution semantics, not to individual model, Tool, or orchestration frameworks.* Semantically equivalent canonical evidence from a different provider, model, binding, workflow id, or Tool execution origin receives the same verdict and the same assertions.
  - Result ids still differ, because Run identity and provider metadata are part of the evidence fingerprint.
  - Adapter-specific conformance tests come later. They prove the mapping into AAO semantics; they do not redefine AAO criteria.

### Explicitly not decided or built in this sprint

- No Eval store, history, analytics, baselines, or trends (Sprint 18).
- No CI or release Eval gate (Sprint 18). The Evaluation Runtime's own software tests run in CI normally.
- No adapter contract or conformance certification (Sprints 18 and 20).
- No Eval-driven Runtime gating, Approval, retry, or recovery decisions.
- No automatic regression-case creation, Reflexion or evaluator-optimizer loop, memory promotion, Skill Runtime, or model/provider benchmark runner.
- No semantic Tool-argument grading. Trace deliberately excludes Tool arguments, and Tool Runtime already guarantees schema-valid input before a handler runs. Semantic argument quality would need explicit host-supplied evidence and is deferred rather than inferred from Trace.
- No side-effect enablement: `external_side_effect`, `destructive`, and `sensitive_data` remain unsupported, and a passing `EvalResult` has no path to the Tool support gate.

## Consequences

- Given AAO evidence, a versioned definition, and a trusted grader version, AAO produces a reproducible, privacy-minimized verdict. The same verdict holds across providers and integration origins that map into the same AAO semantics.
- Sprint 18 can build result history, dataset analytics, baseline and candidate comparison, CI quality and regression gates, and adapter verification on serializable `EvalResult`s. Stable `resultId`, `evalRef`, `graderRef`, and `datasetRef` + `caseId` make that possible.
- Sprint 20 formalizes `AdapterManifest`, capability declarations, the compatibility matrix, conformance contracts, and AAO port interfaces under one principle: *external substrates implement AAO interfaces; they do not define AAO semantics.*
- Future Toolbox evaluators stay provider-neutral. They assert the right *capability* was used (`crm.accounts.search`), not that a vendor SDK method was called, except in explicit adapter-conformance evals.
