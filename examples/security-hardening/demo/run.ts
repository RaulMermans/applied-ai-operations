// Sprint 29 offline security proof: `pnpm proof:security-hardening`.
// Fictional companies, local fixtures, no network, no credentials.
import { FIXTURE_SECRET, runSecurityRegressionSuite } from "../src/index.js";

const results = await runSecurityRegressionSuite();
const lines: string[] = ["AAO Sprint 29 — security hardening proof (offline, fictional data)", ""];
for (const area of [...new Set(results.map((r) => r.area))]) {
  lines.push(`[${area}]`);
  for (const r of results.filter((x) => x.area === area)) lines.push(`  ${r.passed ? "PASS" : "FAIL"}  ${r.id} — ${r.evidence}`);
}
const failed = results.filter((r) => !r.passed);
lines.push("", `${results.length - failed.length}/${results.length} security invariants hold`);
const output = lines.join("\n");
if (output.includes(FIXTURE_SECRET)) throw new Error("proof output contains the fixture secret");
console.log(output);
process.exitCode = failed.length === 0 ? 0 : 1;
