import type { JsonObject } from "@aao/contracts";
import type { AdapterCapability, AdapterKind } from "../capabilities.js";

/**
 * A canonical conformance scenario (conformance v1). It names an AAO
 * behavior, never a framework construct. Its `parameters` are JSON-safe
 * canonical setup that any subject of its kind can reproduce: identities,
 * inputs, state keys, host configuration, and scripted substrate outcomes.
 * They are never provider payloads.
 *
 * - `requires`: the capabilities the scenario verifies. It runs only when
 *   the manifest declares every one `supported`. If any is declared
 *   `unsupported`, it is reported UNSUPPORTED. A scenario that requires
 *   nothing is a base invariant (authority non-escalation, for example) and
 *   runs for every adapter of its kind.
 * - `boundary`: what the subject must observe at its own provider boundary,
 *   beyond canonical evidence. Today the only field is `cancellationObserved`,
 *   because cancellation reaching a provider leaves no Trace evidence by
 *   design.
 */
export interface AdapterConformanceScenario {
  readonly id: string;
  readonly kind: AdapterKind;
  readonly title: string;
  readonly requires: readonly AdapterCapability[];
  readonly boundary?: { readonly cancellationObserved: true };
  readonly parameters: JsonObject;
}

/**
 * Scripted outcome of one physical Tool call, reproduced by the subject's
 * substrate (a local handler, a remote server): `success` returns the
 * expected output, `failure` a non-transient error, `transient_failure` a
 * transient error the subject reports as retryable if it can.
 */
export type ToolScenarioOutcome = "success" | "failure" | "transient_failure";

/**
 * Scripted model behavior: `text` / `structured` succeed, `provider_error`
 * fails at the provider with a seeded secret, `tool_call` responds with a
 * provider tool call, `never_settles` ignores the signal and never
 * resolves, and `blocks_until_cancelled` settles only when the invocation
 * signal aborts.
 */
export type ModelScenarioOutcome = "text" | "structured" | "provider_error" | "tool_call" | "never_settles" | "blocks_until_cancelled";

const tool: JsonObject = {
  toolRef: { id: "crm.account.read", version: "1.0.0" },
  permissionClasses: ["read_only"],
  principal: { id: "user.conformance", type: "user" },
  input: { accountId: "a-1" },
  inputStateKey: "accountRequest",
  resultStateKey: "accountResult",
  expectedOutput: { id: "a-1", name: "Local Test Account" },
  hostRetrySafety: "unsafe",
  outcomes: ["success"],
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

export const ADAPTER_CONFORMANCE_SCENARIOS: readonly AdapterConformanceScenario[] = deepFreezeScenarios([
  // --- tool_provider ---
  { id: "tool.success-structured-result", kind: "tool_provider", title: "An authorized read-only Tool call succeeds and its structured result maps into AAO state", requires: ["tool.execution"], parameters: { ...tool, grantedPermissionClasses: ["read_only"] } },
  { id: "tool.unauthorized-blocked", kind: "tool_provider", title: "A caller without the permission class is blocked by Authorization before the substrate is reached", requires: [], parameters: { ...tool, grantedPermissionClasses: [] } },
  { id: "tool.unsupported-permission-blocked", kind: "tool_provider", title: "A host-declared side-effect class stays unsupported even when granted: refused at preflight, the substrate is never reached", requires: [], parameters: { ...tool, permissionClasses: ["external_side_effect"], grantedPermissionClasses: ["external_side_effect"] } },
  { id: "tool.failure-normalized", kind: "tool_provider", title: "A substrate error becomes the normalized TOOL_EXECUTION_FAILED with no raw payload", requires: ["tool.execution"], parameters: { ...tool, grantedPermissionClasses: ["read_only"], outcomes: ["failure"] } },
  { id: "tool.transient-retry", kind: "tool_provider", title: "A transient failure of a Tool the host declared retry-safe is retried once by the Runtime and then succeeds (one logical execution, two physical calls)", requires: ["tool.execution", "tool.retryable_failure"], parameters: { ...tool, grantedPermissionClasses: ["read_only"], hostRetrySafety: "safe", maxAttempts: 2, outcomes: ["transient_failure", "success"] } },
  { id: "tool.unsafe-default-no-retry", kind: "tool_provider", title: "Without a host retry-safety declaration the same transient failure is never retried", requires: ["tool.execution"], parameters: { ...tool, grantedPermissionClasses: ["read_only"], hostRetrySafety: "unsafe", maxAttempts: 2, outcomes: ["transient_failure", "success"] } },
  { id: "tool.discovery-metadata-non-authoritative", kind: "tool_provider", title: "Discovered metadata claiming retry safety, idempotency, or authority changes nothing: the host's unsafe binding is not retried and its read_only class stands", requires: ["tool.discovery", "tool.execution"], parameters: { ...tool, grantedPermissionClasses: ["read_only"], hostRetrySafety: "unsafe", maxAttempts: 2, outcomes: ["transient_failure", "success"], hostileMetadata: true } },
  // --- model ---
  { id: "model.structured-output", kind: "model", title: "A structured model response maps into a schema-valid AAO ModelResult", requires: ["model.structured_output"], parameters: { ...model, outputKind: "structured", outcome: "structured" } },
  { id: "model.identity-and-usage", kind: "model", title: "Trusted model identity and exact token usage map into canonical Trace", requires: ["model.text_generation", "model.usage"], parameters: { ...model, outputKind: "text", outcome: "text" } },
  { id: "model.provider-error-normalized", kind: "model", title: "A provider error becomes MODEL_INVOCATION_FAILED/provider_error without leaking the raw error", requires: ["model.text_generation"], parameters: { ...model, outputKind: "text", outcome: "provider_error" } },
  { id: "model.tool-call-fail-closed", kind: "model", title: "A provider tool-call response fails closed as unsupported_response", requires: ["model.tool_call_response"], parameters: { ...model, outputKind: "text", outcome: "tool_call" } },
  { id: "model.attempt-timeout", kind: "model", title: "A model call that never settles is abandoned at the Runtime attempt-timeout boundary and cannot commit late", requires: ["model.text_generation"], parameters: { ...model, outputKind: "text", outcome: "never_settles", attemptTimeoutMs: 1000 } },
  { id: "model.cancellation-propagated", kind: "model", title: "A Runtime attempt timeout aborts the invocation signal and the provider boundary observes the abort", requires: ["model.text_generation", "model.cancellation"], boundary: { cancellationObserved: true }, parameters: { ...model, outputKind: "text", outcome: "blocks_until_cancelled", attemptTimeoutMs: 1000 } },
]);

export const conformanceScenarioEvidenceRef = (scenarioId: string) => `scenario://${scenarioId}`;

/** The canonical scenarios of one kind, in suite order. */
export function conformanceScenariosForKind(kind: AdapterKind): readonly AdapterConformanceScenario[] {
  return ADAPTER_CONFORMANCE_SCENARIOS.filter((scenario) => scenario.kind === kind);
}

function deepFreezeScenarios(scenarios: AdapterConformanceScenario[]): readonly AdapterConformanceScenario[] {
  const freeze = <T>(value: T): T => {
    if (value !== null && typeof value === "object") {
      for (const nested of Object.values(value)) freeze(nested);
      Object.freeze(value);
    }
    return value;
  };
  return freeze(JSON.parse(JSON.stringify(scenarios)) as AdapterConformanceScenario[]);
}
