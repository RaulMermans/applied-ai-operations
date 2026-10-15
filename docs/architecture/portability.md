# Portability

AAO business logic, workflow semantics, governance, evaluation, and durability remain independent of concrete model, Tool, and agent frameworks. Adapters map external substrate behavior into canonical AAO contracts. They never redefine AAO contracts ([ADR-025](../decisions/ADR-025-adapter-and-portability-contract.md)).

```text
Workflow definition (canonical refs only: modelPolicyRef, toolRef, executorRef, agentRef)
       ↓
AAO Runtime (Governance · Authorization · Approval · Reliability · Durability · Trace)
       ↓
canonical port (ModelAdapter · RegisteredTool)
       ↓
adapter (declared by an AdapterManifest, verified by conformance)
       ↓
substrate (provider SDK · MCP server · local handler)
```

The invariant echoes the ports-and-adapters separation found in mature execution platforms (ECC-style "core never imports the edge"). It is adopted as an AAO rule, not as a dependency on any such platform.

## Where substrate choice lives

| Layer | Contains | Never contains |
| --- | --- | --- |
| Workflow | `modelPolicyRef`, Tool identity (`toolRef`), `executorRef`, `agentRef` | adapter ids, SDK options, provider or protocol names |
| Host configuration | `ModelBindingDefinition { adapterRef }`, Tool bindings (`createMcpToolBinding` + host `retrySafety`), deterministic executors, Agents | business logic |
| Adapter package | executable port + manifest + conformance subject | AAO authority (identity, permissions, approval, safety) |

Changing provider means changing host configuration. The Workflow, its compiled plan fingerprint, its Governance, and its Evals do not change.

## Proof

- **Scenario level.** `aao eval adapters` runs the canonical conformance suite for the native references and for each official adapter. Native Tool and MCP reach identical semantic verdicts on 16 shared cases, and native model and Vercel AI SDK on 9 ([matrix](../framework/adapter-compatibility.md)).
- **Workflow level.** The cross-adapter E2E (`packages/framework/test/portability.e2e.test.ts`) and the compiled Sprint 20 smoke run one vendor-free Workflow twice:

  ```text
  prepare (deterministic) → classify (model) → approve (approval) → read (tool) → final
  A: native model reference + native Tool
  B: Vercel AI SDK adapter + MCP Tool provider (stdio)
  ```

  Workflow identity (plan fingerprint), node trajectory, self-approval refusal and human approval, final state shape and semantic values, and the comparison keys and semantic verdict fingerprints of the same Eval definitions are all identical. Trace bytes are not required to match.

## What portability does not mean

- **Not universal compatibility.** Only adapters that pass the canonical conformance suite for their declared capabilities are interchangeable, and only for those capabilities. Passing means a complete canonical report for the adapter's own manifest (`adapterConformancePassed(report, manifest)`), never only an intact or partial one.
- **Not authority.** A compatible, conformant adapter is still subject to Governance, Authorization, the Tool support gate, and Approval on every Run.
- **Not side effects.** `external_side_effect`, `destructive`, and `sensitive_data` remain unsupported, whatever an adapter or server claims.
- **Not LangGraph.** No `agent_runtime` adapter exists. The native bounded Agent Runtime is the reference semantics.
