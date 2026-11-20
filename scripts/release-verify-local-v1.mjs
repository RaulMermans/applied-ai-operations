import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectReleasePacks, assertPackInventory } from "./pack-inventory.mjs";
import { assertDocumentedCommands } from "./documented-commands.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const afterCore = process.argv.includes("--after-core");
const skipBenchmarks = process.argv.includes("--skip-benchmarks") || process.env.CI === "true";

const steps = [];

function run(id, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "true", ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const expected = options.marker;
  const passed = result.status === 0 && (!expected || output.includes(expected));
  steps.push({
    id,
    command: [command, ...args].join(" "),
    exitCode: result.status,
    passed,
    marker: expected ?? null,
    tail: output.trim().split("\n").slice(-8).join("\n"),
  });
  if (!passed) {
    process.stderr.write(`FAIL ${id}\n${output}\n`);
    throw new Error(`release step failed: ${id}`);
  }
  process.stdout.write(`ok  ${id}\n`);
  return output;
}

if (!afterCore) {
  run("core.check", "pnpm", ["check"]);
}

const smokes = afterCore
  ? [
      ["framework.sprint20", ["--filter", "@aao/framework", "smoke:sprint20"], "SPRINT_20_ADAPTER_PORTABILITY_CONTRACT_SMOKE_OK"],
      ["toolbox.sprint21", ["--filter", "@aao/toolbox", "smoke:sprint21"], "SPRINT_21_TOOLBOX_FOUNDATION_SMOKE_OK"],
      ["company-research.sprint22", ["--filter", "@aao/example-company-research", "smoke:sprint22"], "SPRINT_22_COMPANY_RESEARCH_PROOF_SMOKE_OK"],
      ["document-intelligence.sprint23", ["--filter", "@aao/example-document-intelligence", "smoke:sprint23"], "SPRINT_23_DOCUMENT_INTELLIGENCE_PROOF_SMOKE_OK"],
      ["operational-request.sprint24", ["--filter", "@aao/example-operational-request", "smoke:sprint24"], "SPRINT_24_OPERATIONAL_REQUEST_PROOF_SMOKE_OK"],
      ["company-portability.sprint25", ["--filter", "@aao/example-company-portability", "smoke:sprint25"], "SPRINT_25_COMPANY_PORTABILITY_PROOF_SMOKE_OK"],
      ["capability-packs.sprint26", ["--filter", "@aao/example-capability-packs", "smoke:sprint26"], "SPRINT_26_CAPABILITY_PACKS_SMOKE_OK"],
      ["operator-inspection.sprint27", ["--filter", "@aao/example-operator-inspection", "smoke:sprint27"], "SPRINT_27_OPERATOR_INSPECTION_SMOKE_OK"],
      ["operator-inspection.sprint28", ["--filter", "@aao/example-operator-inspection", "smoke:sprint28"], "SPRINT_28_GUIDED_INTEGRATION_RUN_INSPECTOR_SMOKE_OK"],
      ["security.sprint29", ["--filter", "@aao/example-security-hardening", "smoke:sprint29"], "SPRINT_29_SECURITY_IDENTITY_ADAPTER_HARDENING_SMOKE_OK"],
    ]
  : [
      ["evaluation.sprint18", ["--filter", "@aao/evaluation", "smoke:sprint18"], "SPRINT_18_EVAL_ANALYTICS_CI_ADAPTER_VERIFICATION_SMOKE_OK"],
      ["framework.sprint19", ["--filter", "@aao/framework", "smoke"], "SPRINT_19_FRAMEWORK_SURFACE_SMOKE_OK"],
      ["framework.sprint20", ["--filter", "@aao/framework", "smoke:sprint20"], "SPRINT_20_ADAPTER_PORTABILITY_CONTRACT_SMOKE_OK"],
      ["toolbox.sprint21", ["--filter", "@aao/toolbox", "smoke:sprint21"], "SPRINT_21_TOOLBOX_FOUNDATION_SMOKE_OK"],
      ["company-research.sprint22", ["--filter", "@aao/example-company-research", "smoke:sprint22"], "SPRINT_22_COMPANY_RESEARCH_PROOF_SMOKE_OK"],
      ["document-intelligence.sprint23", ["--filter", "@aao/example-document-intelligence", "smoke:sprint23"], "SPRINT_23_DOCUMENT_INTELLIGENCE_PROOF_SMOKE_OK"],
      ["operational-request.sprint24", ["--filter", "@aao/example-operational-request", "smoke:sprint24"], "SPRINT_24_OPERATIONAL_REQUEST_PROOF_SMOKE_OK"],
      ["company-portability.sprint25", ["--filter", "@aao/example-company-portability", "smoke:sprint25"], "SPRINT_25_COMPANY_PORTABILITY_PROOF_SMOKE_OK"],
      ["capability-packs.sprint26", ["--filter", "@aao/example-capability-packs", "smoke:sprint26"], "SPRINT_26_CAPABILITY_PACKS_SMOKE_OK"],
      ["operator-inspection.sprint27", ["--filter", "@aao/example-operator-inspection", "smoke:sprint27"], "SPRINT_27_OPERATOR_INSPECTION_SMOKE_OK"],
      ["operator-inspection.sprint28", ["--filter", "@aao/example-operator-inspection", "smoke:sprint28"], "SPRINT_28_GUIDED_INTEGRATION_RUN_INSPECTOR_SMOKE_OK"],
      ["security.sprint29", ["--filter", "@aao/example-security-hardening", "smoke:sprint29"], "SPRINT_29_SECURITY_IDENTITY_ADAPTER_HARDENING_SMOKE_OK"],
    ];

for (const [id, args, marker] of smokes) {
  run(id, "pnpm", args, { marker });
}

run("proof.company-research", "pnpm", ["proof:company-research"]);
run("proof.document-intelligence", "pnpm", ["proof:document-intelligence"]);
run("proof.operational-request", "pnpm", ["proof:operational-request"]);
run("proof.company-portability", "pnpm", ["proof:company-portability"]);
run("proof.capability-packs", "pnpm", ["proof:capability-packs"]);
run("proof.operator-inspection", "pnpm", ["proof:operator-inspection"]);
run("proof.security-hardening", "pnpm", ["proof:security-hardening"]);
run("consumer.sprint30", "pnpm", ["--filter", "@aao/example-release-consumer", "smoke:sprint30"], { marker: "SPRINT_30_LOCAL_V1_RELEASE_SMOKE_OK" });

if (!skipBenchmarks) {
  run("benchmark.local-v1", "pnpm", ["benchmark:local-v1"], { marker: "AAO_LOCAL_V1_BENCHMARK_OK" });
}

const packs = assertPackInventory(inspectReleasePacks(root));
steps.push({ id: "pack.inventory", command: "scripts/pack-inventory.mjs", exitCode: 0, passed: true, marker: null, tail: `${packs.length} packages inspected` });
const commands = assertDocumentedCommands(root);
steps.push({ id: "docs.commands", command: "scripts/documented-commands.mjs", exitCode: 0, passed: true, marker: null, tail: commands.scripts.length.toString() });

const requiredDocs = [
  "docs/guides/getting-started-local-v1.md",
  "docs/framework/public-api.md",
  "docs/release/local-v1-acceptance.md",
  "docs/release/local-v1-limitations.md",
  "docs/release/local-v1-release-notes.md",
  "docs/benchmarks/local-v1-results.md",
  "docs/release/capability-inventory.md",
  "docs/release/versioning.md",
];
for (const relative of requiredDocs) {
  readFileSync(join(root, relative), "utf8");
}
steps.push({ id: "docs.required", command: "required release docs", exitCode: 0, passed: true, marker: null, tail: requiredDocs.join(",") });

const failed = steps.filter((step) => !step.passed);
const decision = failed.length === 0 ? "LOCAL_V1_READY" : "LOCAL_V1_BLOCKED";
const report = {
  schemaVersion: 1,
  suite: "aao.release.verify.local-v1",
  decision,
  afterCore,
  skipBenchmarks,
  steps,
};
const outDir = join(root, "docs/release/out");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "latest-verify.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ decision, steps: steps.map((step) => ({ id: step.id, passed: step.passed })) }, null, 2)}\n`);
process.stdout.write(`${decision}\n`);
if (decision !== "LOCAL_V1_READY") process.exitCode = 1;
