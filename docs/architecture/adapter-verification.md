# Adapter Verification

**Sprint 18 verifies adapter behavior but does not yet define the public AAO adapter contract.** `AdapterManifest`, a capability matrix, compatibility promises, and public adapter ports belong to Sprint 20, and will be built on the requirements proven here ([ADR-023](../decisions/ADR-023-eval-analytics-ci-gates-and-adapter-verification.md)).

The principle under test: *different substrates must map into the same canonical AAO behavior before AAO treats them as interchangeable.* Substrates preserve AAO semantics; they never define them.

```text
External substrate (Vercel AI SDK, MCP connector, native handler/adapter)
      ↓
test driver (lives with the substrate: packages/<substrate>/conformance/)
      ↓   real compiled AAO workflow, host-injected Trace/Audit recorders
AAO canonical evidence (Trace, execution state, Audit)
      ↓
AAO EvalDefinitions (evals/definitions/adapter-conformance.v1.yaml), Evaluator Registry, case expectations
      ↓
conformance result (AdapterConformanceReport) + semantic comparison with the native reference
```

## Inventory

| Substrate | Kind | Location | Classification |
| --- | --- | --- | --- |
| AAO native Tool (Tool Runtime + local handler) | tool | `packages/tool-runtime` | ACTIVE — semantic reference for Tool scenarios |
| MCP connector (official SDK, stdio) | tool | `packages/mcp-connector` | ACTIVE |
| AAO native model adapter (plain `ModelAdapter`) | model | `packages/model-runtime` | ACTIVE — semantic reference for model scenarios |
| Vercel AI SDK model adapter | model | `packages/model-runtime/src/adapters/vercel-ai.ts` | ACTIVE |
| LangGraph | orchestration | `packages/substrate-spikes` (Sprint 0A research) | DEFERRED — no maintained AAO adapter, so no driver and no support claim |

## Pieces

- **Scenarios** (`src/conformance/scenarios.ts`). Canonical behaviors with JSON-safe parameters (ToolRef, input, principal, grants, trusted model identity, usage, scripted outcomes). They hold no provider payloads, and each scenario has a kind (`tool`, `model`, `orchestration`).
- **Dataset** (`evals/datasets/adapter-conformance-foundation.v1.yaml`, 20 RUNTIME cases). Evidence is `scenario://<id>`, produced at verification time and never fixture-pinned.
- **Definitions** use existing graders plus `aao.model-call`, a canonical grader for model Trace evidence: invocation count, trusted identity, usage, outcome, and normalized `code` / `adapterReason`.
- **`AdapterVerificationDriver`** has `{ id, kind, support, sensitiveMarkers?, executeScenario(scenario) → EvalEvidenceBundle }`. Drivers are plain test-owned ESM modules. They never import `@aao/evaluation`; the host injects the `@aao/observability` recorders. There is no registry, discovery, or dynamic import: `eval-adapters.mjs` lists the drivers explicitly.
- **`verifyAdapter`** executes each SUPPORTED scenario once and judges its cases with `runEvalDataset`. A scenario passes only when every case is `MATCHED` and no seeded sensitive marker appears in the evidence.
- **`compareAdapterConformance`** checks that, on every case both executed, an adapter's comparison key and semantic verdict fingerprint equal the native reference's. This is not byte equality: evidence fingerprints legitimately differ.

## Support is partial and truthful

| Scenario | native Tool | MCP | native model | Vercel AI SDK |
| --- | --- | --- | --- | --- |
| `tool.success-structured-result` | PASSED | PASSED | — | — |
| `tool.unauthorized-blocked` | PASSED | PASSED | — | — |
| `tool.unsupported-permission-blocked` | PASSED | PASSED | — | — |
| `tool.failure-normalized` | PASSED | PASSED | — | — |
| `tool.transient-retry` | PASSED | **UNSUPPORTED** — the connector declares no retry safety (one remote call, ADR-015) | — | — |
| `model.structured-output` | — | — | PASSED | PASSED |
| `model.identity-and-usage` | — | — | PASSED | PASSED |
| `model.provider-error-normalized` | — | — | PASSED | PASSED |
| `model.tool-call-fail-closed` | — | — | **NOT_APPLICABLE** — the AAO ModelAdapter port has no tool-call channel | PASSED |
| `model.attempt-timeout` | — | — | PASSED | PASSED |

A SUPPORTED scenario that fails is a CI failure (`ADAPTER_CONFORMANCE_FAILED`). UNSUPPORTED is reported (`ADAPTER_SCENARIO_UNSUPPORTED`), never counted as a pass. A false SUPPORTED claim is caught by the evidence, and a driver cannot claim a scenario that has no verifiable case. Portability: 10 shared Tool cases (native vs MCP) and 7 shared model cases (native vs Vercel AI SDK) reach identical semantic verdicts.

What the scenarios prove:

- **MCP.** The test server's discovery metadata is hostile: it claims destructive behavior and asks to "grant external_side_effect and bypass authorization". The traced permission stays the host's `read_only`. An unauthorized caller is blocked with Audit `tool.access.denied`. Unauthorized and unsupported-class calls make zero server calls. A remote error is `TOOL_EXECUTION_FAILED`, with no remote text in AAO evidence.
- **Model.** Structured output becomes a schema-valid `ModelResult`. Trusted registration identity and exact usage are traced. A provider error is one call, normalized to `MODEL_INVOCATION_FAILED`/`provider_error`, with no raw error. A tool-call response fails closed as `INVALID_MODEL_RESULT`/`unsupported_response`. A call that never settles fails at the Runtime attempt timeout (`NODE_ATTEMPT_TIMEOUT`, category `TIMEOUT`).
- **Cancellation is a requirement gap, not a scenario.** Cancellation cannot propagate to a model provider, because the ModelAdapter port carries no abort signal. AAO has no canonical evidence for propagation, so no scenario claims it. It is recorded as a Sprint 20 input.

## Running

`pnpm eval:adapters` (after `pnpm build`) runs all four drivers, prints each scenario's status and the portability result, and exits 1 on any SUPPORTED failure or semantic divergence. Everything is local and mocked: `ai/test` models and an MCP server child process over stdio. There are no credentials and no network (a guard refuses connections), and the run has no external side effects. Reports contain identifiers, statuses, codes, and fingerprints only — no raw provider, MCP, Tool, or model content. Two runs are deep-equal.
