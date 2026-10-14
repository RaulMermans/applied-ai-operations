import { z } from "zod";
import { EvalReasonCodeSchema, type TraceEvent } from "@aao/contracts";
import { assertion, judged, zodConfig, type EvalGrader } from "../grader.js";
import { payload, readTrace, refs } from "../trace-view.js";

const IdentitySchema = z.object({ provider: z.string().min(1).max(128), model: z.string().min(1).max(128), revision: z.string().min(1).max(128).optional() }).strict();
const UsageSchema = z.object({ inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(), totalTokens: z.number().int().nonnegative().optional() }).strict();

const ConfigSchema = z
  .object({
    /** Bounds on model invocations (`model.call.started`). */
    expectedCalls: z.object({ min: z.number().int().nonnegative().optional(), max: z.number().int().nonnegative().optional() }).strict().refine((range) => range.min !== undefined || range.max !== undefined, "min or max").optional(),
    /** Every traced call carries exactly this trusted registration identity (never parsed from model output). */
    expectedIdentity: IdentitySchema.optional(),
    /** Every completed call reports usage with these exact counts. */
    expectedUsage: UsageSchema.refine((usage) => Object.keys(usage).length > 0, "at least one count").optional(),
    /** Every invocation ends this way. */
    expectedOutcome: z.enum(["completed", "failed"]).optional(),
    /** Every failed call carries this normalized code and/or adapter reason (requires expectedOutcome failed). */
    expectedFailure: z.object({ failureCode: EvalReasonCodeSchema.optional(), adapterReason: z.enum(["provider_error", "unsupported_response", "unparseable_output"]).optional() }).strict().refine((failure) => failure.failureCode !== undefined || failure.adapterReason !== undefined, "failureCode or adapterReason").optional(),
    requireTerminal: z.boolean().default(true),
  })
  .strict()
  .refine((config) => config.expectedCalls || config.expectedIdentity || config.expectedUsage || config.expectedOutcome, "at least one criterion")
  .refine((config) => !config.expectedFailure || config.expectedOutcome === "failed", "expectedFailure requires expectedOutcome failed");
type Config = z.infer<typeof ConfigSchema>;

const sameIdentity = (actual: unknown, expected: z.infer<typeof IdentitySchema>) => {
  const identity = actual as { provider?: unknown; model?: unknown; revision?: unknown } | undefined;
  return identity !== undefined && identity.provider === expected.provider && identity.model === expected.model && identity.revision === expected.revision;
};

/**
 * `aao.model-call` (Sprint 18) — deterministic checks over canonical model
 * Trace events: invocation count, trusted model identity, token usage,
 * outcome, and normalized failure (`code`, `adapterReason`). It judges how
 * any model adapter's behavior *maps into AAO evidence*; it never sees
 * prompts, model output, or provider payloads (the Trace has none), and it
 * names no provider SDK. Adapter verification reuses it unchanged across
 * substrates.
 */
export function createModelCallGrader(): EvalGrader<Config> {
  return {
    id: "aao.model-call",
    version: "1.0.0",
    supportedModes: ["OFFLINE", "RUNTIME"],
    supportedTargetTypes: ["run", "node"],
    validateConfig: zodConfig(ConfigSchema),
    evaluate({ config, evidence }) {
      const read = readTrace(evidence, { requireTerminal: config.requireTerminal });
      if (!read.ok) return read.outcome;
      const events = read.view.events;
      const started = events.filter((event) => event.type === "model.call.started");
      const completed = events.filter((event) => event.type === "model.call.completed");
      const failed = events.filter((event) => event.type === "model.call.failed");
      const assertions = [];

      if (config.expectedCalls) {
        const { min, max } = config.expectedCalls;
        assertions.push(assertion("model.call-count", (min === undefined || started.length >= min) && (max === undefined || started.length <= max), { reasonCode: "MODEL_CALL_COUNT_MISMATCH", evidenceRefs: refs(started) }));
      }
      if (config.expectedIdentity) {
        const expected = config.expectedIdentity;
        const traced = [...started, ...completed];
        const wrong = traced.filter((event) => !sameIdentity(payload(event).modelIdentity, expected));
        assertions.push(assertion("model.identity", traced.length > 0 && wrong.length === 0, { reasonCode: "MODEL_IDENTITY_MISMATCH", evidenceRefs: refs(wrong.length > 0 ? wrong : traced) }));
      }
      if (config.expectedUsage) {
        const expected = config.expectedUsage;
        const wrong = completed.filter((event) => {
          const usage = payload(event).usage as Record<string, unknown> | undefined;
          return usage === undefined || Object.entries(expected).some(([key, value]) => usage[key] !== value);
        });
        assertions.push(assertion("model.usage", completed.length > 0 && wrong.length === 0, { reasonCode: "MODEL_USAGE_MISMATCH", evidenceRefs: refs(wrong.length > 0 ? wrong : completed) }));
      }
      if (config.expectedOutcome) {
        const terminalOf = (invocationId: unknown): TraceEvent | undefined => [...completed, ...failed].filter((event) => payload(event).invocationId === invocationId).sort((a, b) => b.sequence - a.sequence)[0];
        const outcomes = started.map((event) => terminalOf(payload(event).invocationId));
        const wanted = config.expectedOutcome === "completed" ? "model.call.completed" : "model.call.failed";
        const wrong = outcomes.filter((event) => event?.type !== wanted);
        assertions.push(assertion("model.outcome", started.length > 0 && wrong.length === 0, { reasonCode: "MODEL_OUTCOME_MISMATCH", evidenceRefs: refs(outcomes.filter((event): event is TraceEvent => event !== undefined)) }));
      }
      if (config.expectedFailure) {
        const { failureCode, adapterReason } = config.expectedFailure;
        const wrong = failed.filter((event) => (failureCode !== undefined && payload(event).code !== failureCode) || (adapterReason !== undefined && payload(event).adapterReason !== adapterReason));
        assertions.push(assertion("model.failure", failed.length > 0 && wrong.length === 0, { reasonCode: "MODEL_FAILURE_MISMATCH", evidenceRefs: refs(wrong.length > 0 ? wrong : failed) }));
      }
      return judged(assertions);
    },
  };
}
