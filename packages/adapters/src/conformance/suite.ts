import type { EvalDataset, EvalDefinition, JsonObject } from "@aao/contracts";
import { AAO_ADAPTER_CONFORMANCE_VERSION } from "../version.js";
import { conformanceScenarioEvidenceRef } from "./scenarios.js";

/**
 * The canonical adapter conformance suite (conformance v1): ordinary AAO
 * `EvalDefinition`s and one `EvalDataset`, judged by the existing
 * Evaluation Runtime and deterministic graders. There is no adapter
 * assertion engine. Nothing here names a framework, provider, SDK, or
 * protocol. It holds only canonical Trace event types, ToolRefs, Run
 * status, failure codes, state paths, and trusted model identity.
 *
 * Shipped as package data (migrated from `evals/` in Sprint 20), so a
 * third-party adapter can be verified without repository paths.
 */
const ACCOUNT_TOOL = { id: "crm.account.read", version: "1.0.0" };

function definition(id: string, name: string, categories: EvalDefinition["categories"], targetType: EvalDefinition["targetType"], grader: string, config: JsonObject): EvalDefinition {
  return { schemaVersion: 2, id, version: "1.0.0", name, categories, supportedModes: ["RUNTIME"], targetType, graderRef: { id: grader, version: "1.0.0" }, config } as EvalDefinition;
}

const DEFINITIONS: EvalDefinition[] = [
  definition("conformance.trace-valid", "The substrate's evidence satisfies the AAO Trace contract", ["trace_contract"], "run", "aao.trace-contract", { requireTerminal: true }),
  definition("conformance.run-completed", "The Run completes", ["capability"], "run", "aao.run-outcome", { expectedStatus: "COMPLETED" }),
  definition("conformance.run-failed-node-execution", "The Run fails with the normalized node execution failure", ["capability"], "run", "aao.run-outcome", { expectedStatus: "FAILED", expectedFailureCode: "NODE_EXECUTION_FAILED" }),
  definition("conformance.tool-invoked-once", "The CRM read Tool is invoked exactly once (one physical call, one logical execution)", ["tool_use"], "tool_use", "aao.tool-usage", {
    requiredTools: [ACCOUNT_TOOL],
    callLimits: [{ tool: ACCOUNT_TOOL, count: "physical", min: 1, max: 1 }, { tool: ACCOUNT_TOOL, count: "logical", min: 1, max: 1 }],
  }),
  definition("conformance.tool-retried-physically", "One logical CRM read execution made exactly two physical calls", ["tool_use"], "tool_use", "aao.tool-usage", {
    requiredTools: [ACCOUNT_TOOL],
    callLimits: [{ tool: ACCOUNT_TOOL, count: "physical", min: 2, max: 2 }, { tool: ACCOUNT_TOOL, count: "logical", min: 1, max: 1 }],
  }),
  definition("conformance.tool-result-mapped", "The Tool's structured result maps into AAO state", ["tool_use"], "state", "aao.state-assertion", {
    checks: [
      { id: "result-id", op: "path_equals", path: "/accountResult/output/id", value: "a-1" },
      { id: "result-name", op: "path_equals", path: "/accountResult/output/name", value: "Local Test Account" },
      { id: "result-tool", op: "path_equals", path: "/accountResult/toolRef", value: ACCOUNT_TOOL },
    ],
  }),
  definition("conformance.tool-unauthorized-blocked", "An unauthorized CRM read is blocked by Authorization and never reaches the handler", ["tool_use", "authorization", "safety"], "tool_use", "aao.tool-usage", {
    expectedBlocked: [{ tool: ACCOUNT_TOOL, failureCode: "TOOL_AUTHORIZATION_DENIED" }],
  }),
  definition("conformance.authorization-denial-audited", "The Authorization denial is enforced and agrees with Audit", ["authorization", "safety"], "authorization", "aao.authorization-compliance", {
    expectedDenials: [{ tool: ACCOUNT_TOOL, reasonCode: "PERMISSION_NOT_GRANTED" }],
    crossCheckAudit: true,
  }),
  definition("conformance.run-refused-at-preflight", "A workflow naming a Tool with an unsupported side-effect class is refused at Runtime preflight", ["safety"], "run", "aao.run-outcome", { expectedStatus: "FAILED", expectedFailureCode: "RUNTIME_PREFLIGHT_FAILED" }),
  definition("conformance.tool-never-invoked", "The CRM read Tool's handler is never invoked", ["tool_use", "safety"], "tool_use", "aao.tool-usage", { forbiddenTools: [ACCOUNT_TOOL] }),
  definition("conformance.tool-failure-normalized", "A handler or remote error is the normalized TOOL_EXECUTION_FAILED", ["tool_use"], "tool_use", "aao.tool-usage", {
    expectedFailures: [{ tool: ACCOUNT_TOOL, failureCode: "TOOL_EXECUTION_FAILED" }],
  }),
  definition("conformance.tool-transient-retried", "Exactly one Runtime retry of the transient failure, without exhaustion", ["tool_use"], "run", "aao.retry-behavior", { expectedRetries: 1, expectExhausted: false }),
  definition("conformance.tool-not-retried", "The Runtime schedules no retry", ["tool_use", "safety"], "run", "aao.retry-behavior", { expectedRetries: 0 }),
  definition("conformance.model-structured-output", "The structured model output maps into a schema-valid ModelResult in state", ["capability"], "state", "aao.state-assertion", {
    checks: [
      { id: "output-kind", op: "path_equals", path: "/modelResult/outputKind", value: "structured" },
      { id: "output-category", op: "path_equals", path: "/modelResult/output/category", value: "research" },
      { id: "output-binding", op: "path_equals", path: "/modelResult/modelBindingId", value: "conformance.binding" },
    ],
  }),
  definition("conformance.model-identity-usage", "One model call with the trusted registered identity and exact token usage", ["capability"], "run", "aao.model-call", {
    expectedCalls: { min: 1, max: 1 },
    expectedIdentity: { provider: "conformance-provider", model: "conformance-model" },
    expectedUsage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 },
    expectedOutcome: "completed",
  }),
  definition("conformance.model-provider-error", "A provider error is one failed call normalized to MODEL_INVOCATION_FAILED / provider_error", ["capability"], "run", "aao.model-call", {
    expectedCalls: { min: 1, max: 1 },
    expectedOutcome: "failed",
    expectedFailure: { failureCode: "MODEL_INVOCATION_FAILED", adapterReason: "provider_error" },
  }),
  definition("conformance.model-tool-call-fail-closed", "A provider tool-call response fails closed as INVALID_MODEL_RESULT / unsupported_response", ["capability", "safety"], "run", "aao.model-call", {
    expectedCalls: { min: 1, max: 1 },
    expectedOutcome: "failed",
    expectedFailure: { failureCode: "INVALID_MODEL_RESULT", adapterReason: "unsupported_response" },
  }),
  definition("conformance.model-attempt-timeout", "A model call that never settles fails the Run at the Runtime attempt-timeout boundary", ["capability"], "run", "aao.run-outcome", { expectedStatus: "FAILED", expectedFailureCategory: "TIMEOUT" }),
];

/** `[caseId, definitionId, scenarioId]`: one case = one scenario judged by one definition. */
const CASES: ReadonlyArray<readonly [string, string, string]> = [
  ["tool.success.trace-valid.001", "conformance.trace-valid", "tool.success-structured-result"],
  ["tool.success.run-completed.001", "conformance.run-completed", "tool.success-structured-result"],
  ["tool.success.invoked-once.001", "conformance.tool-invoked-once", "tool.success-structured-result"],
  ["tool.success.result-mapped.001", "conformance.tool-result-mapped", "tool.success-structured-result"],
  ["tool.unauthorized.blocked.001", "conformance.tool-unauthorized-blocked", "tool.unauthorized-blocked"],
  ["tool.unauthorized.denial-audited.001", "conformance.authorization-denial-audited", "tool.unauthorized-blocked"],
  ["tool.unsupported-permission.preflight-refused.001", "conformance.run-refused-at-preflight", "tool.unsupported-permission-blocked"],
  ["tool.unsupported-permission.never-invoked.001", "conformance.tool-never-invoked", "tool.unsupported-permission-blocked"],
  ["tool.failure.normalized.001", "conformance.tool-failure-normalized", "tool.failure-normalized"],
  ["tool.failure.run-failed.001", "conformance.run-failed-node-execution", "tool.failure-normalized"],
  ["tool.transient.retried-once.001", "conformance.tool-transient-retried", "tool.transient-retry"],
  ["tool.transient.run-completed.001", "conformance.run-completed", "tool.transient-retry"],
  ["tool.transient.physical-calls.001", "conformance.tool-retried-physically", "tool.transient-retry"],
  ["tool.unsafe-default.not-retried.001", "conformance.tool-not-retried", "tool.unsafe-default-no-retry"],
  ["tool.unsafe-default.invoked-once.001", "conformance.tool-invoked-once", "tool.unsafe-default-no-retry"],
  ["tool.unsafe-default.run-failed.001", "conformance.run-failed-node-execution", "tool.unsafe-default-no-retry"],
  ["tool.hostile-metadata.not-retried.001", "conformance.tool-not-retried", "tool.discovery-metadata-non-authoritative"],
  ["tool.hostile-metadata.invoked-once.001", "conformance.tool-invoked-once", "tool.discovery-metadata-non-authoritative"],
  ["tool.hostile-metadata.run-failed.001", "conformance.run-failed-node-execution", "tool.discovery-metadata-non-authoritative"],
  ["model.structured.run-completed.001", "conformance.run-completed", "model.structured-output"],
  ["model.structured.output-mapped.001", "conformance.model-structured-output", "model.structured-output"],
  ["model.identity-usage.mapped.001", "conformance.model-identity-usage", "model.identity-and-usage"],
  ["model.identity-usage.trace-valid.001", "conformance.trace-valid", "model.identity-and-usage"],
  ["model.provider-error.normalized.001", "conformance.model-provider-error", "model.provider-error-normalized"],
  ["model.provider-error.run-failed.001", "conformance.run-failed-node-execution", "model.provider-error-normalized"],
  ["model.tool-call.fail-closed.001", "conformance.model-tool-call-fail-closed", "model.tool-call-fail-closed"],
  ["model.timeout.run-failed.001", "conformance.model-attempt-timeout", "model.attempt-timeout"],
  ["model.cancellation.run-failed.001", "conformance.model-attempt-timeout", "model.cancellation-propagated"],
  ["model.cancellation.trace-valid.001", "conformance.trace-valid", "model.cancellation-propagated"],
];

const DATASET: EvalDataset = {
  schemaVersion: 2,
  id: "aao.adapter-conformance",
  version: "1.0.0",
  name: "AAO adapter conformance v1",
  description: "Canonical behaviors every model or Tool-provider adapter must preserve when mapped into AAO evidence: identity, errors, Tools, authority, retry and cancellation, Trace, and output mapping.",
  cases: CASES.map(([id, evalId, scenarioId]) => ({ id, evalRef: { id: evalId, version: "1.0.0" }, mode: "RUNTIME", evidenceRef: conformanceScenarioEvidenceRef(scenarioId), expected: { status: "passed" } })),
} as EvalDataset;

export interface AdapterConformanceSuite {
  readonly conformanceVersion: typeof AAO_ADAPTER_CONFORMANCE_VERSION;
  readonly definitions: readonly EvalDefinition[];
  readonly dataset: EvalDataset;
}

/** The suite, deep-frozen. Callers that need a mutable copy clone it. */
export const ADAPTER_CONFORMANCE_SUITE: AdapterConformanceSuite = freeze({ conformanceVersion: AAO_ADAPTER_CONFORMANCE_VERSION, definitions: DEFINITIONS, dataset: DATASET });

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}
