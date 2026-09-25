import { isJsonSafe } from "@aao/runtime";
import { executeModelRequest, type ModelPolicyRegistry, type ModelRegistry, type ModelUsage } from "@aao/model-runtime";
import { buildIterationModelRequest } from "./decision.js";
import type { AgentRegistry } from "./registry.js";
import { resolveExecutableAgent } from "./resolution.js";
import {
  AgentDecisionSchema,
  AgentExecutionRequestSchema,
  AgentResultSchema,
  type AgentExecutionResult,
  type AgentExecutionState,
  type AgentFailure,
  type AgentIterationRecord,
  type AgentResult,
} from "./types.js";

export interface AgentRuntimeDependencies {
  agents: AgentRegistry;
  policies: ModelPolicyRegistry;
  models: ModelRegistry;
}

export interface ExecuteAgentParams extends AgentRuntimeDependencies {
  /** Untrusted: validated before anything else happens. */
  request: unknown;
}

/**
 * The single canonical bounded Agent execution path:
 *
 *   AgentExecutionRequest → Agent Registry → Agent binding → Controller
 *     → Model Runtime (structured AgentDecision) → Controller → AgentResult
 *
 * The deterministic controller — never the model — owns continuation:
 *
 * - one iteration = at most one `executeModelRequest` call, so model calls
 *   can never exceed the registered `maxIterations`;
 * - the model may only propose `CONTINUE` or `COMPLETE`;
 * - `CONTINUE` on the final permitted iteration fails with
 *   `MAX_AGENT_ITERATIONS_EXCEEDED` — never an extra call, never a silent
 *   reinterpretation as `COMPLETE`, never the draft returned as success;
 * - any Model Runtime failure ends the Agent: no retry, no alternate model,
 *   no restart, no backtracking, no evaluator.
 *
 * Model selection comes only from the registered `AgentSpec.modelPolicyRef`
 * through Model Runtime's deterministic routing, identically on every
 * iteration. Expected failures are values; only programming-invariant
 * violations throw. The workflow Agent Node calls this same function — there
 * is no second Agent execution path.
 */
export async function executeAgent(params: ExecuteAgentParams): Promise<AgentExecutionResult> {
  if (!isJsonSafe(params.request)) {
    return fail({ code: "INVALID_AGENT_REQUEST", message: "Agent execution request is not JSON-safe." });
  }
  const parsed = AgentExecutionRequestSchema.safeParse(params.request);
  if (!parsed.success) {
    return fail({
      code: "INVALID_AGENT_REQUEST",
      message: "Agent execution request does not match AgentExecutionRequestSchema.",
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    });
  }
  const request = parsed.data;

  const resolution = resolveExecutableAgent(request.agentRef, params);
  if (!resolution.ok) return fail({ ...resolution.failure, agentExecutionId: request.agentExecutionId });
  const { agent, modelPolicyRef } = resolution;
  // Read once from the registered binding. Nothing below — task text, model
  // output — can change these.
  const { maxIterations } = agent.limits;

  const state: AgentExecutionState = {
    agentExecutionId: request.agentExecutionId,
    agentRef: { ...request.agentRef },
    task: request.task,
    iteration: 1,
    history: [],
  };
  const failAt = (failure: Omit<AgentFailure, "agentExecutionId" | "agentRef" | "iteration" | "history">): AgentExecutionResult =>
    fail({ ...failure, agentExecutionId: state.agentExecutionId, agentRef: { ...state.agentRef }, iteration: state.iteration, history: state.history.map((record) => ({ ...record })) });

  // Bounded by construction: at most `maxIterations` passes, and every pass
  // either returns or advances `iteration` by exactly one.
  for (state.iteration = 1; state.iteration <= maxIterations; state.iteration += 1) {
    const outcome = await executeModelRequest({ request: buildIterationModelRequest(agent, state), modelPolicyRef, policies: params.policies, models: params.models });

    if (!outcome.ok) {
      const modelFailureCode = outcome.failure.code;
      // A structured result that violates the decision JSON Schema is an
      // invalid *decision*, not a model execution failure.
      if (modelFailureCode === "MODEL_OUTPUT_SCHEMA_MISMATCH") {
        return failAt({ code: "INVALID_AGENT_DECISION", message: `Iteration ${state.iteration} returned an invalid AgentDecision.`, modelFailureCode });
      }
      return failAt({ code: "AGENT_MODEL_EXECUTION_FAILED", message: `Iteration ${state.iteration} model execution failed.`, modelFailureCode });
    }

    const modelResult = outcome.result;
    const decision = modelResult.outputKind === "structured" ? AgentDecisionSchema.safeParse(modelResult.output) : undefined;
    if (decision === undefined || !decision.success) {
      return failAt({ code: "INVALID_AGENT_DECISION", message: `Iteration ${state.iteration} returned an invalid AgentDecision.` });
    }

    state.history.push({
      iteration: state.iteration,
      action: decision.data.action,
      output: decision.data.output,
      invocationId: modelResult.invocationId,
      modelBindingId: modelResult.modelBindingId,
      ...(modelResult.usage !== undefined ? { usage: { ...modelResult.usage } } : {}),
    });

    if (decision.data.action === "COMPLETE") return succeed(state);

    if (state.iteration === maxIterations) {
      return failAt({
        code: "MAX_AGENT_ITERATIONS_EXCEEDED",
        message: `Agent proposed CONTINUE on its final permitted iteration (${maxIterations}).`,
      });
    }
    state.currentWorkingOutput = decision.data.output;
  }

  // Unreachable: the final permitted iteration always returns above.
  throw new Error("executeAgent: iteration loop exited without a terminal decision.");
}

function succeed(state: AgentExecutionState): AgentExecutionResult {
  const last = state.history.at(-1);
  if (last === undefined) throw new Error("executeAgent: completed without iteration evidence.");
  const usage = totalUsage(state.history);
  const candidate: AgentResult = {
    schemaVersion: 1,
    agentExecutionId: state.agentExecutionId,
    agentRef: { ...state.agentRef },
    finalOutput: last.output,
    iterationsUsed: state.history.length,
    history: state.history.map((record) => ({ ...record })),
    ...(usage !== undefined ? { usage } : {}),
  };
  const validated = AgentResultSchema.safeParse(candidate);
  if (!validated.success || !isJsonSafe(validated.data)) {
    throw new Error("executeAgent: produced an AgentResult that fails its own schema.");
  }
  return { ok: true, result: validated.data };
}

/** Per-field totals, only for fields every iteration reported — missing counts are never invented. */
function totalUsage(history: readonly AgentIterationRecord[]): ModelUsage | undefined {
  const totals: ModelUsage = {};
  for (const field of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    const values = history.map((record) => record.usage?.[field]);
    if (values.every((value): value is number => value !== undefined)) totals[field] = values.reduce((sum, value) => sum + value, 0);
  }
  return Object.keys(totals).length > 0 ? totals : undefined;
}

function fail(failure: AgentFailure): AgentExecutionResult {
  return { ok: false, failure };
}
