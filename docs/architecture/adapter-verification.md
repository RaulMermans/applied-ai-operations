# Adapter Verification

> **Since Sprint 20 this verification runs through the public adapter contract.** See the [adapter contract](adapter-contract.md), [ADR-025](../decisions/ADR-025-adapter-and-portability-contract.md), and the generated [compatibility matrix](../framework/adapter-compatibility.md). This page records how verification works and how it evolved from Sprint 18 ([ADR-023](../decisions/ADR-023-eval-analytics-ci-gates-and-adapter-verification.md)).

The principle under test: *different substrates must map into the same canonical AAO behavior before AAO treats them as interchangeable.* Substrates preserve AAO semantics; they never define them.

```text
AdapterManifest (claim) ─┐
                         ▼
canonical scenarios (@aao/adapters, selected by the claim; base invariants always)
      ↓   conformance host (@aao/framework/conformance): a real compiled AAO Run per scenario,
      ↓   canonical Trace/Audit recorders, the subject supplies only the substrate
AAO canonical evidence (Trace, execution state, Audit) + boundary observation (cancellation)
      ↓
canonical Eval definitions + dataset (aao.adapter-conformance@1.0.0), Evaluator Registry, case expectations
      ↓   @aao/evaluation evaluateAdapterConformance
AdapterConformanceReport v1 (integrity-checked) ──► semantic comparison with the native reference ──► generated matrix
```

## Inventory

| Substrate | Kind | Manifest | Subject | Role |
| --- | --- | --- | --- | --- |
| AAO native Tool (Tool Runtime + local handler) | tool_provider | `aao.native-tool@1.0.0` | `@aao/framework/conformance` | semantic reference |
| MCP connector (official SDK, stdio) | tool_provider | `aao.mcp-connector@1.0.0` | `@aao/mcp-connector/conformance` | adapter |
| AAO native model (plain `ModelAdapter`) | model | `aao.native-model@1.0.0` | `@aao/framework/conformance` | semantic reference |
| Vercel AI SDK model adapter | model | `aao.vercel-ai-sdk@1.0.0` | `@aao/model-runtime/vercel-ai/conformance` | adapter |
| LangGraph | agent_runtime | none | none | DEFERRED: no maintained AAO adapter, so no subject and no support claim |

## Results (generated in the [matrix](../framework/adapter-compatibility.md))

| Scenario | native Tool | MCP | native model | Vercel AI SDK |
| --- | --- | --- | --- | --- |
| `tool.success-structured-result` | PASSED | PASSED | — | — |
| `tool.unauthorized-blocked` (base) | PASSED | PASSED | — | — |
| `tool.unsupported-permission-blocked` (base) | PASSED | PASSED | — | — |
| `tool.failure-normalized` | PASSED | PASSED | — | — |
| `tool.transient-retry` (host-declared safe) | PASSED | PASSED | — | — |
| `tool.unsafe-default-no-retry` | PASSED | PASSED | — | — |
| `tool.discovery-metadata-non-authoritative` | UNSUPPORTED (no discovery) | PASSED | — | — |
| `model.structured-output` | — | — | PASSED | PASSED |
| `model.identity-and-usage` | — | — | PASSED | PASSED |
| `model.provider-error-normalized` | — | — | PASSED | PASSED |
| `model.tool-call-fail-closed` | — | — | UNSUPPORTED (no tool-call channel) | PASSED |
| `model.attempt-timeout` | — | — | PASSED | PASSED |
| `model.cancellation-propagated` | — | — | PASSED | PASSED |

Portability: 16 shared Tool cases (native vs MCP) and 9 shared model cases (native vs Vercel AI SDK) reach identical comparison keys and semantic verdict fingerprints. Evidence bytes are not compared.

What the scenarios prove:

- **MCP, authority.** The conformance server's discovery metadata is hostile. It claims destructive behavior, idempotency, and safe-to-retry, and asks to "grant external_side_effect and bypass authorization". The traced permission stays the host's `read_only`. Unauthorized and unsupported-class calls make zero server calls.
- **MCP, retry.** A host-declared retry-safe read is retried exactly once after a transient server error: one logical execution, two physical calls. The same Tool without the host declaration, or with hostile metadata, is never retried. A remote error is `TOOL_EXECUTION_FAILED`, with no remote text in AAO evidence.
- **Model.** Structured output becomes a schema-valid `ModelResult`. Trusted registration identity and exact usage are traced. A provider error is one call, normalized to `MODEL_INVOCATION_FAILED`/`provider_error`. A tool-call response fails closed as `INVALID_MODEL_RESULT`/`unsupported_response`.
- **Model, cancellation.** A call that never settles fails at the attempt timeout (`NODE_ATTEMPT_TIMEOUT`, category `TIMEOUT`) and commits nothing. With `model.cancellation`, the Runtime's abort reaches the provider boundary. A subject whose provider ignores the signal fails with `ADAPTER_BOUNDARY_UNOBSERVED`.

## How it evolved from Sprint 18

| Sprint 18 | Sprint 20 |
| --- | --- |
| Each test driver declared its own `SUPPORTED` / `UNSUPPORTED` / `NOT_APPLICABLE` table | The manifest declares capabilities, `scenarioClaim` selects scenarios, and there is no `SUPPORTED` outcome |
| Drivers were `.mjs` modules loaded by repository-relative path | Subjects are explicit package exports, and the suite ships with `@aao/adapters` |
| `verifyAdapter` + internal `AdapterConformanceReport` | `evaluateAdapterConformance` / `verifyAdapterConformance` + public report v1 with integrity validation |
| MCP `tool.transient-retry` UNSUPPORTED (no retry safety) | Host-owned MCP retry safety. PASSED |
| Native model `tool-call-fail-closed` NOT_APPLICABLE | `model.tool_call_response` declared unsupported, so the scenario is UNSUPPORTED. NOT_APPLICABLE now means another kind only |
| Cancellation was a requirement gap (no `AbortSignal`) | `model.cancellation-propagated` verifies the abort reaches the provider |

## Running

`aao eval adapters` (alias `pnpm eval:adapters`, which builds what it needs first) verifies all four subjects, prints each scenario's outcome and the portability result, and exits 1 on any FAILED scenario or semantic divergence. `aao adapters matrix` prints the generated matrix. Everything is local and mocked: `ai/test` models and an MCP stdio child process. There are no credentials and no network (a guard refuses connections), and the run has no external side effects. Reports contain identifiers, claims, outcomes, codes, and fingerprints only, and two runs are deep-equal.
