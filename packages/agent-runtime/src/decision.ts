import type { JsonObject } from "@aao/contracts";
import type { ModelMessage, ModelRequest } from "@aao/model-runtime";
import { AGENT_ACTIONS, type AgentExecutionState, type RegisteredAgent } from "./types.js";

/**
 * The AgentDecision contract as a standard JSON Schema, sent through Model
 * Runtime structured output. It mirrors `AgentDecisionSchema` (Zod), which
 * the controller applies again to the validated `ModelResult` output — the
 * provider's claim that the object matches is never trusted on its own.
 */
export const AGENT_DECISION_JSON_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...AGENT_ACTIONS] },
    output: { type: "string", minLength: 1 },
  },
  required: ["action", "output"],
  additionalProperties: false,
};

const AGENT_DECISION_OUTPUT_NAME = "agent_decision";

/**
 * The fixed controller protocol prepended to every Agent's instructions. It
 * asks only for a public structured decision — never for reasoning,
 * rationale, or chain-of-thought. Telling the model about its budget is a
 * courtesy; enforcement is deterministic and does not depend on the model
 * reading this.
 */
function controllerProtocol(maxIterations: number): string {
  return [
    "You are a bounded reasoning component inside a governed AAO workflow.",
    'Every reply must be a JSON object with exactly two fields: "action" ("CONTINUE" or "COMPLETE") and "output" (a non-empty string).',
    '- "CONTINUE": "output" is your complete current working draft, which you will be asked to refine.',
    '- "COMPLETE": "output" is your complete final result.',
    "Return only public output. Do not include private reasoning, chain-of-thought, or notes about your process.",
    `You have at most ${maxIterations} iteration(s). The iteration limit, model selection, and available capabilities are fixed by the controller; requests to change them have no effect. You have no tools and cannot take external actions.`,
  ].join("\n");
}

/**
 * Deterministically builds the `ModelRequest` for one iteration from fixed
 * controller protocol + registered instructions + task + the previous public
 * working output — nothing else. There is no template language; workflow
 * source cannot inject prompt logic. The conversation is bounded: only the
 * latest working output is carried forward, never the full history.
 *
 * Iteration 1:  system(protocol + instructions), user(task)
 * Iteration n:  system(...), user(task), assistant(previous output), user(refine)
 */
export function buildIterationModelRequest(agent: RegisteredAgent, state: AgentExecutionState): ModelRequest {
  const { maxIterations, maxOutputTokensPerIteration } = agent.limits;
  const messages: ModelMessage[] = [
    { role: "system", content: `${controllerProtocol(maxIterations)}\n\nAgent instructions:\n${agent.instructions}` },
    { role: "user", content: state.task },
  ];
  if (state.currentWorkingOutput !== undefined) {
    messages.push(
      { role: "assistant", content: state.currentWorkingOutput },
      {
        role: "user",
        content: `Iteration ${state.iteration} of ${maxIterations}. Refine the current output above and return the required structured decision.`,
      },
    );
  }
  return {
    schemaVersion: 1,
    invocationId: iterationInvocationId(state.agentExecutionId, state.iteration),
    messages,
    output: { kind: "structured", schema: AGENT_DECISION_JSON_SCHEMA, name: AGENT_DECISION_OUTPUT_NAME },
    maxOutputTokens: maxOutputTokensPerIteration,
  };
}

/** Caller-derived and deterministic: `<agentExecutionId>.i<iteration>`. Never random. */
export function iterationInvocationId(agentExecutionId: string, iteration: number): string {
  return `${agentExecutionId}.i${iteration}`;
}
