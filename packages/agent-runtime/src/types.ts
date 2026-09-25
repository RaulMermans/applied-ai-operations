import { z } from "zod";
import { AgentIdSchema, AgentSpecSchema, entityVersionSchema, identifierSchema } from "@aao/contracts";
import { ModelFailureCodeSchema, ModelUsageSchema } from "@aao/model-runtime";

// --- Agent reference ------------------------------------------------------------

/**
 * A stable, version-exact reference to a registered Agent, using the
 * canonical `AgentSpec` identity (`id` + entity `version`). Lookup is exact:
 * there is no "latest", range, or fuzzy version resolution.
 */
export const AgentRefSchema = z
  .object({
    id: AgentIdSchema,
    version: entityVersionSchema,
  })
  .strict();
export type AgentRef = z.infer<typeof AgentRefSchema>;

// --- Limits -------------------------------------------------------------------

/**
 * The V1 hard ceiling on Agent iterations. Every registered Agent declares
 * its own `maxIterations` in `[1, MAX_AGENT_ITERATIONS_CEILING]`; there is no
 * unlimited mode (no `0`, `Infinity`, or sentinel meaning "unbounded").
 * One iteration is at most one Model Runtime invocation, so this is also the
 * hard ceiling on model calls per Agent execution.
 */
export const MAX_AGENT_ITERATIONS_CEILING = 16;

/** The V1 hard ceiling on the output-token budget of a single iteration. */
export const MAX_OUTPUT_TOKENS_PER_ITERATION_CEILING = 32_768;

export const AgentLimitsSchema = z
  .object({
    maxIterations: z.number().int().min(1).max(MAX_AGENT_ITERATIONS_CEILING),
    maxOutputTokensPerIteration: z.number().int().min(1).max(MAX_OUTPUT_TOKENS_PER_ITERATION_CEILING),
  })
  .strict();
export type AgentLimits = z.infer<typeof AgentLimitsSchema>;

// --- Registered Agent (runtime binding) --------------------------------------

/** Upper bound on registered instructions; generous, but never unbounded. */
export const MAX_AGENT_INSTRUCTIONS_LENGTH = 32_000;

/**
 * The Agent Runtime's registration/binding for one Agent: the canonical
 * `AgentSpec` (identity and semantics, reused intact from `@aao/contracts`
 * — never duplicated) plus runtime implementation configuration that
 * `AgentSpec` intentionally does not carry: trusted, code-registered
 * `instructions` and explicit bounded `limits`. Workflow source cannot
 * supply or alter any of this.
 */
export const RegisteredAgentSchema = z
  .object({
    spec: AgentSpecSchema,
    instructions: z
      .string()
      .min(1)
      .max(MAX_AGENT_INSTRUCTIONS_LENGTH)
      .refine((value) => value.trim().length > 0, "instructions must not be blank"),
    limits: AgentLimitsSchema,
  })
  .strict();
export type RegisteredAgent = z.infer<typeof RegisteredAgentSchema>;

// --- Request ------------------------------------------------------------------

/**
 * Leaves room for the per-iteration Model Runtime `invocationId` suffix
 * (`.i<n>`) while staying within the canonical 256-character identifier limit.
 */
export const MAX_AGENT_EXECUTION_ID_LENGTH = 240;

/** Upper bound on a task's length; Sprint 7 tasks are plain text. */
export const MAX_AGENT_TASK_LENGTH = 32_000;

/**
 * A JSON-safe, text-task Agent execution request. `agentExecutionId` is
 * always caller-owned — the Agent Runtime never generates ids. There is no
 * provider configuration, tool context, filesystem context, memory, or
 * secret here, and nothing in `task` can alter limits, model policy, or
 * tool availability: those come only from the registered Agent.
 */
export const AgentExecutionRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    agentExecutionId: identifierSchema.max(MAX_AGENT_EXECUTION_ID_LENGTH),
    agentRef: AgentRefSchema,
    task: z
      .string()
      .min(1)
      .max(MAX_AGENT_TASK_LENGTH)
      .refine((value) => value.trim().length > 0, "task must not be blank"),
  })
  .strict();
export type AgentExecutionRequest = z.infer<typeof AgentExecutionRequestSchema>;

// --- Decision -----------------------------------------------------------------

export const AGENT_ACTIONS = ["CONTINUE", "COMPLETE"] as const;
export const AgentActionSchema = z.enum(AGENT_ACTIONS);
export type AgentAction = z.infer<typeof AgentActionSchema>;

/**
 * The only thing the model decides per iteration. `CONTINUE`: `output` is the
 * next public working draft to refine. `COMPLETE`: `output` is the final
 * Agent result. Strict: any other field (e.g. `maxIterations`,
 * `modelPolicyRef`, `tools`) is rejected, never interpreted. No reasoning,
 * rationale, or chain-of-thought field exists or is requested.
 */
export const AgentDecisionSchema = z
  .object({
    action: AgentActionSchema,
    output: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0, "output must not be blank"),
  })
  .strict();
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;

// --- Iteration evidence ---------------------------------------------------------

/**
 * Execution evidence for one Agent iteration: the decision the model
 * proposed, its public working output, and stable normalized metadata
 * already produced by Model Runtime. It is also a future
 * trajectory-evaluation input. It is **not** canonical Trace infrastructure
 * and **not** memory: it exists only for the current bounded invocation and
 * contains no provider response, hidden reasoning, stack, credential, or
 * HTTP metadata.
 */
export const AgentIterationRecordSchema = z
  .object({
    iteration: z.number().int().min(1).max(MAX_AGENT_ITERATIONS_CEILING),
    action: AgentActionSchema,
    output: z.string().min(1),
    invocationId: identifierSchema,
    modelBindingId: identifierSchema,
    usage: ModelUsageSchema.optional(),
  })
  .strict();
export type AgentIterationRecord = z.infer<typeof AgentIterationRecordSchema>;

const historySchema = z.array(AgentIterationRecordSchema).max(MAX_AGENT_ITERATIONS_CEILING);

// --- Result -------------------------------------------------------------------

/**
 * A provider-neutral, JSON-safe successful Agent result. Internally
 * consistent by construction (and re-checked here): `iterationsUsed` equals
 * the history length, iterations are numbered `1..n`, every record but the
 * last is `CONTINUE`, the last is `COMPLETE`, and `finalOutput` is the last
 * record's output. `usage` holds per-field totals only when *every*
 * iteration reported that field — missing token counts are never invented.
 */
export const AgentResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    agentExecutionId: identifierSchema,
    agentRef: AgentRefSchema,
    finalOutput: z.string().min(1),
    iterationsUsed: z.number().int().min(1).max(MAX_AGENT_ITERATIONS_CEILING),
    history: historySchema.min(1),
    usage: ModelUsageSchema.optional(),
  })
  .strict()
  .superRefine((result, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (result.iterationsUsed !== result.history.length) issue("iterationsUsed must equal history.length");
    result.history.forEach((record, index) => {
      if (record.iteration !== index + 1) issue("history iterations must be numbered 1..n in order");
      const isLast = index === result.history.length - 1;
      if (record.action !== (isLast ? "COMPLETE" : "CONTINUE")) issue("only the last history record may be COMPLETE, and it must be");
    });
    if (result.history.at(-1)?.output !== result.finalOutput) issue("finalOutput must equal the last iteration's output");
  });
export type AgentResult = z.infer<typeof AgentResultSchema>;

// --- Failures -----------------------------------------------------------------

export const AGENT_FAILURE_CODES = [
  "INVALID_AGENT_REQUEST",
  "AGENT_NOT_FOUND",
  "UNSUPPORTED_AGENT_CONFIGURATION",
  "AGENT_MODEL_POLICY_NOT_FOUND",
  "AGENT_MODEL_EXECUTION_FAILED",
  "INVALID_AGENT_DECISION",
  "MAX_AGENT_ITERATIONS_EXCEEDED",
] as const;
export const AgentFailureCodeSchema = z.enum(AGENT_FAILURE_CODES);
export type AgentFailureCode = z.infer<typeof AgentFailureCodeSchema>;

/**
 * A deterministic, JSON-safe Agent failure value. `message` and `issues` are
 * built by the Agent Runtime from safe metadata only. `modelFailureCode`
 * preserves the safe Model Runtime code behind `AGENT_MODEL_EXECUTION_FAILED`
 * / `INVALID_AGENT_DECISION` (never its message or details). `iteration` is
 * the iteration that failed; `history` is the Agent-local evidence of the
 * iterations that completed before the failure — direct-caller/eval
 * evidence only, never written to workflow state.
 */
export const AgentFailureSchema = z
  .object({
    code: AgentFailureCodeSchema,
    message: z.string(),
    agentExecutionId: identifierSchema.optional(),
    agentRef: AgentRefSchema.optional(),
    iteration: z.number().int().min(1).max(MAX_AGENT_ITERATIONS_CEILING).optional(),
    modelFailureCode: ModelFailureCodeSchema.optional(),
    issues: z.array(z.string()).optional(),
    history: historySchema.optional(),
  })
  .strict();
export type AgentFailure = z.infer<typeof AgentFailureSchema>;

export type AgentExecutionResult = { ok: true; result: AgentResult } | { ok: false; failure: AgentFailure };

// --- Agent-local working state ------------------------------------------------

/**
 * The in-memory working state of one bounded Agent invocation. Distinct from
 * workflow `RunState`: it is never written to workflow state mid-execution,
 * never persisted or checkpointed, and discarded when the invocation ends. It
 * is not memory (no cross-run or cross-invocation content).
 */
export interface AgentExecutionState {
  agentExecutionId: string;
  agentRef: AgentRef;
  task: string;
  /** The iteration currently being executed (1-based). */
  iteration: number;
  /** The latest public working output proposed with `CONTINUE`, if any. */
  currentWorkingOutput?: string;
  history: AgentIterationRecord[];
}
