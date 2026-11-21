import { z } from "zod";

/**
 * RE:VERSE-owned RollbackProof contracts (Sprint 0). Deliberately local to
 * the app: not an AAO Core contract until a second consumer justifies it.
 */

export const STEP_IDS = ["schema_v1", "seed_v1", "v1_pre_read", "migration", "v2_write", "v2_read", "v1_post_write", "v1_post_read"] as const;
export type StepId = (typeof STEP_IDS)[number];

export type StepOutcome =
  | { id: StepId; ok: true; rows?: Record<string, unknown>[] }
  | { id: StepId; ok: false; sqlstate: string | null; message: string };

export const ABORT_REASONS = ["CONTAINER_START_FAILED", "TIMEOUT", "DATABASE_UNAVAILABLE", "RUNNER_ERROR"] as const;
export type AbortReason = (typeof ABORT_REASONS)[number];

/** Execution result: did the runner complete its operations? Says nothing about compatibility. */
export type Execution = {
  status: "COMPLETED" | "ABORTED";
  abort_reason: AbortReason | null;
  steps: StepOutcome[];
  postgres_version: string | null;
  started_at: string;
  completed_at: string;
};

/**
 * SQLSTATE classes that indicate the database/infrastructure failed rather
 * than the application contract: 08 connection, 53 resources, 57 operator
 * intervention (incl. 57014 statement timeout), 58 system, XX internal.
 * A missing SQLSTATE means a client/transport error. Neither may yield PASS or FAIL.
 */
export function isInfraFailure(sqlstate: string | null): boolean {
  return sqlstate === null || /^(08|53|57|58|XX)/.test(sqlstate);
}

export const VerdictSchema = z.enum(["PASS", "FAIL", "INCONCLUSIVE"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const VerificationReportSchema = z
  .object({
    schema_version: z.literal(1),
    scenario_id: z.string().min(1),
    scenario_version: z.number().int().positive(),
    fixture_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    // No Bitbucket commit exists in Sprint 0; never fabricate one.
    source: z.object({ kind: z.literal("local_fixture"), commit_sha: z.null() }),
    postgres_image: z.string().min(1),
    postgres_version: z.string().nullable(),
    runner_version: z.string().min(1),
    started_at: z.string().datetime(),
    completed_at: z.string().datetime(),
    execution_status: z.enum(["COMPLETED", "ABORTED"]),
    result: VerdictSchema,
    reason_codes: z.array(z.string()),
    verified_invariants: z.array(z.string()),
    failed_invariants: z.array(z.string()),
    /** Report label only: whether this scenario is a deliberate negative. The evaluator never reads it. */
    expectation: z.object({ expected_result: z.enum(["PASS", "FAIL"]), met: z.boolean() }),
    cleanup: z.object({ container_removed: z.boolean().nullable() }),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.result === "PASS" && (r.failed_invariants.length > 0 || r.verified_invariants.length === 0 || r.execution_status !== "COMPLETED")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "PASS requires a completed execution, verified invariants and no failures" });
    }
    if (r.result === "FAIL" && (r.failed_invariants.length === 0 || r.execution_status !== "COMPLETED")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "FAIL requires a completed execution and at least one failed invariant" });
    }
    if (r.result === "INCONCLUSIVE" && r.reason_codes.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "INCONCLUSIVE requires a reason code" });
    }
  });
export type VerificationReport = z.infer<typeof VerificationReportSchema>;
