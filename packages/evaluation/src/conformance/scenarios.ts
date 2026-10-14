import type { JsonObject } from "@aao/contracts";

/**
 * Canonical adapter verification scenarios (Sprint 18, ADR-023,
 * docs/architecture/adapter-verification.md). A scenario names a canonical
 * AAO behavior, not a framework construct; each substrate's own test
 * driver reproduces it and returns canonical AAO evidence. The same
 * versioned EvalDefinitions then judge every substrate.
 *
 * Kinds stay distinct — a model adapter, a Tool/capability adapter, and an
 * agent/orchestration adapter have different responsibilities, so a
 * driver only ever sees scenarios of its own kind. This is verification of
 * requirements, not the public Adapter contract (Sprint 20).
 */
export type AdapterKind = "model" | "tool" | "orchestration";

export interface AdapterVerificationScenario {
  readonly id: string;
  readonly kind: AdapterKind;
  readonly title: string;
  /** Canonical, JSON-safe setup every driver of this kind reproduces: identities, inputs, state keys, scripted outcomes. Never provider payloads. */
  readonly parameters: JsonObject;
}

const tool: JsonObject = {
  toolRef: { id: "crm.account.read", version: "1.0.0" },
  permissionClasses: ["read_only"],
  principal: { id: "user.conformance", type: "user" },
  input: { accountId: "a-1" },
  inputStateKey: "accountRequest",
  resultStateKey: "accountResult",
  expectedOutput: { id: "a-1", name: "Local Test Account" },
};

const model: JsonObject = {
  modelPolicyRef: "policy.conformance",
  modelBindingId: "conformance.binding",
  identity: { provider: "conformance-provider", model: "conformance-model" },
  requestStateKey: "modelRequest",
  resultStateKey: "modelResult",
  usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 },
  structuredSchema: { type: "object", properties: { category: { type: "string", enum: ["research", "sales", "support"] } }, required: ["category"], additionalProperties: false },
  structuredOutput: { category: "research" },
  textOutput: "Conformance answer.",
};

export const ADAPTER_VERIFICATION_SCENARIOS: readonly AdapterVerificationScenario[] = Object.freeze([
  { id: "tool.success-structured-result", kind: "tool", title: "An authorized read-only Tool call succeeds and its structured result maps into AAO state", parameters: { ...tool, grantedPermissionClasses: ["read_only"] } },
  { id: "tool.unauthorized-blocked", kind: "tool", title: "A caller without the permission class is blocked before the handler or server is reached", parameters: { ...tool, grantedPermissionClasses: [] } },
  { id: "tool.unsupported-permission-blocked", kind: "tool", title: "A host-declared side-effect class stays unsupported even when granted: the workflow is refused at preflight and the handler or server is never reached", parameters: { ...tool, permissionClasses: ["external_side_effect"], grantedPermissionClasses: ["external_side_effect"] } },
  { id: "tool.failure-normalized", kind: "tool", title: "A handler/remote error becomes the normalized TOOL_EXECUTION_FAILED with no raw payload", parameters: { ...tool, grantedPermissionClasses: ["read_only"] } },
  { id: "tool.transient-retry", kind: "tool", title: "A transient failure of a retry-safe Tool is retried once by the Runtime and then succeeds", parameters: { ...tool, grantedPermissionClasses: ["read_only"], maxAttempts: 2 } },
  { id: "model.structured-output", kind: "model", title: "A structured model response maps into a schema-valid AAO ModelResult", parameters: { ...model, outputKind: "structured" } },
  { id: "model.identity-and-usage", kind: "model", title: "Trusted model identity and token usage map into canonical Trace", parameters: { ...model, outputKind: "text" } },
  { id: "model.provider-error-normalized", kind: "model", title: "A provider error becomes MODEL_INVOCATION_FAILED/provider_error without leaking the raw error", parameters: { ...model, outputKind: "text" } },
  { id: "model.tool-call-fail-closed", kind: "model", title: "A provider tool-call response fails closed as unsupported_response", parameters: { ...model, outputKind: "text" } },
  { id: "model.attempt-timeout", kind: "model", title: "A model call that never settles is abandoned at the Runtime attempt-timeout boundary", parameters: { ...model, outputKind: "text", attemptTimeoutMs: 1000 } },
] satisfies AdapterVerificationScenario[]);

export const scenarioEvidenceRef = (scenarioId: string) => `scenario://${scenarioId}`;
