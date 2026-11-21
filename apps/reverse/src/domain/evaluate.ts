import type { Scenario } from "../fixtures/payment-ledger.js";
import { STEP_IDS, isInfraFailure, type Execution, type StepId, type StepOutcome, type Verdict } from "./contract.js";

export type Evaluation = {
  result: Verdict;
  reason_codes: string[];
  verified_invariants: string[];
  failed_invariants: string[];
};

const inconclusive = (...reason_codes: string[]): Evaluation => ({ result: "INCONCLUSIVE", reason_codes, verified_invariants: [], failed_invariants: [] });

/** Declared expectations come only from the fixture, never from the runner. */
function declared(scenario: Scenario) {
  const ids = [...scenario.seed_v1.map((r) => r.id), ...scenario.v2_writes.map((r) => r.id), ...scenario.v1_post_writes.map((r) => r.id)];
  // v2 amounts are minor units; v1 reads cents, so only exponent-2 rows are declarable in v1 terms.
  if (scenario.v2_writes.some((r) => r.currency_exponent !== 2)) throw new Error("fixture declares a v2 amount v1 cannot represent");
  const total = [...scenario.seed_v1.map((r) => r.amount_cents), ...scenario.v2_writes.map((r) => r.amount_minor), ...scenario.v1_post_writes.map((r) => r.amount_cents)].reduce((a, b) => a + BigInt(b), 0n);
  const seedTotal = scenario.seed_v1.reduce((a, r) => a + BigInt(r.amount_cents), 0n);
  return { ids: ids.sort((a, b) => a - b), total, seedIds: scenario.seed_v1.map((r) => r.id).sort((a, b) => a - b), seedTotal };
}

/** v1's view of the ledger, recomputed from raw rows. null = rows unusable as v1 evidence. */
function v1View(rows: Record<string, unknown>[] | undefined): { ids: number[]; total: bigint } | null {
  if (!rows) return null;
  let total = 0n;
  const ids: number[] = [];
  for (const row of rows) {
    if (!/^-?\d+$/.test(String(row.amount_cents)) || !/^\d+$/.test(String(row.id))) return null;
    total += BigInt(String(row.amount_cents));
    ids.push(Number(row.id));
  }
  return { ids: ids.sort((a, b) => a - b), total };
}

const sameIds = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Independent compatibility evaluator. Pure and deterministic: identical
 * (scenario, execution) input always yields an identical evaluation.
 * A successful migration alone is never treated as evidence of compatibility.
 */
export function evaluate(scenario: Scenario, execution: Execution): Evaluation {
  if (execution.status !== "COMPLETED") return inconclusive(`EXECUTION_ABORTED:${execution.abort_reason ?? "UNKNOWN"}`);

  const steps = new Map<StepId, StepOutcome>(execution.steps.map((s) => [s.id, s]));
  const missing = STEP_IDS.filter((id) => !steps.has(id));
  if (missing.length > 0) return inconclusive(...missing.map((id) => `EVIDENCE_MISSING:${id}`));
  const step = (id: StepId) => steps.get(id) as StepOutcome;

  // Any infra-class failure, even inside a "completed" record, is not compatibility evidence.
  const infra = STEP_IDS.filter((id) => { const s = step(id); return !s.ok && isInfraFailure(s.sqlstate); });
  if (infra.length > 0) return inconclusive(...infra.map((id) => `INFRA_FAILURE:${id}`));

  const want = declared(scenario);

  // Preconditions: the fixture must be valid for v1 before the migration, or nothing can be concluded.
  const pre = step("v1_pre_read");
  const preView = pre.ok ? v1View(pre.rows) : null;
  if (!step("schema_v1").ok || !step("seed_v1").ok || !preView || !sameIds(preView.ids, want.seedIds) || preView.total !== want.seedTotal) {
    return inconclusive("FIXTURE_PRECONDITION_FAILED");
  }
  if (!step("migration").ok) return inconclusive("MIGRATION_REJECTED");
  if (!step("v2_write").ok || !step("v2_read").ok) return inconclusive("V2_CONTRACT_NOT_EXERCISED");

  const verified = ["V1_BASELINE_READ"];
  const failed: string[] = [];
  const reasons: string[] = [];
  const check = (name: string, pass: boolean, reason?: string) => {
    (pass ? verified : failed).push(name);
    if (!pass && reason) reasons.push(reason);
  };

  const write = step("v1_post_write");
  check("V1_WRITE_ACCEPTED", write.ok, write.ok ? undefined : `V1_WRITE_REJECTED:${write.sqlstate}`);
  const read = step("v1_post_read");
  check("V1_READ_ACCEPTED", read.ok, read.ok ? undefined : `V1_READ_REJECTED:${read.sqlstate}`);
  const view = read.ok ? v1View(read.rows) : null;
  check("V1_RECORDS_ACCESSIBLE", view !== null && sameIds(view.ids, want.ids), "V1_RECORDS_NOT_ACCESSIBLE");
  check("V1_DECLARED_TOTAL_PRESERVED", view !== null && view.total === want.total, "V1_DECLARED_TOTAL_MISMATCH");

  return failed.length === 0
    ? { result: "PASS", reason_codes: [], verified_invariants: verified, failed_invariants: [] }
    : { result: "FAIL", reason_codes: reasons, verified_invariants: verified, failed_invariants: failed };
}
