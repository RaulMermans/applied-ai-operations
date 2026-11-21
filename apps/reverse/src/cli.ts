import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS } from "./fixtures/payment-ledger.js";
import type { VerificationReport } from "./domain/contract.js";
import { runAllowlistedScenario } from "./runner/rehearsal.js";

/** Runs every allowlisted scenario N times and persists a reproducibility report. */
export function classify(r: VerificationReport): "EXPECTED_NEGATIVE" | "EXPECTED_POSITIVE" | "INCONCLUSIVE_NOT_A_VERDICT" | "UNEXPECTED_VERDICT" {
  if (r.result === "INCONCLUSIVE") return "INCONCLUSIVE_NOT_A_VERDICT";
  if (!r.expectation.met) return "UNEXPECTED_VERDICT";
  return r.result === "FAIL" ? "EXPECTED_NEGATIVE" : "EXPECTED_POSITIVE";
}

async function main() {
  const repeats = Number(process.argv[2] ?? 3);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error("repeats must be an integer 1..20");
  const runs: (VerificationReport & { run: number; classification: string })[] = [];
  for (let run = 1; run <= repeats; run++) {
    for (const id of Object.keys(SCENARIOS)) {
      const report = await runAllowlistedScenario(id);
      runs.push({ ...report, run, classification: classify(report) });
      process.stdout.write(`run ${run} ${id}: ${report.result} (${classify(report)}) cleanup=${report.cleanup.container_removed}\n`);
    }
  }
  // Reproducible = identical verdict, reasons, invariants and fixture digest across runs of a scenario.
  const fingerprint = (r: VerificationReport) => JSON.stringify([r.fixture_digest, r.result, r.reason_codes, r.verified_invariants, r.failed_invariants]);
  const reproducible = Object.keys(SCENARIOS).every((id) => new Set(runs.filter((r) => r.scenario_id === id).map(fingerprint)).size === 1);
  const ok = reproducible && runs.every((r) => r.expectation.met && r.cleanup.container_removed === true);
  const out = join(dirname(fileURLToPath(import.meta.url)), "../out/rollbackproof-report.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ suite: "reverse.rollbackproof.s0", repeats, reproducible, all_expectations_met: ok, runs }, null, 2)}\n`);
  process.stdout.write(`reproducible=${reproducible} all_expectations_met=${ok} report=${out}\n`);
  process.exitCode = ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`rollbackproof runner error: ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  });
}
