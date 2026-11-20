import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectReleasePacks, assertPackInventory, PACK_SCAN_LIMITATION } from "./pack-inventory.mjs";
import { assertDocumentedCommands } from "./documented-commands.mjs";

const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT_SHA = /^[0-9a-f]{40}$/i;

export const REPORT_SCHEMA_VERSION = 2;
export const REPORT_SUITE = "aao.release.verify.local-v1";
export const DECISIONS = Object.freeze({
  READY: "LOCAL_V1_READY",
  BLOCKED: "LOCAL_V1_BLOCKED",
  NOT_VERIFIED: "LOCAL_V1_NOT_VERIFIED",
});

const FULL_SMOKES = [
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

const REDACT = /-----BEGIN (?:RSA |OPENSSH |EC |DSA |ENCRYPTED )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|\b(?:sk-live-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|xox[baprs]-[A-Za-z0-9-]{10,})\b|_authToken\s*=\s*\S+/g;

export function reportPath(root) {
  return join(root, "docs/release/out/latest-verify.json");
}

function safeTail(output) {
  const text = `${output ?? ""}`.replace(REDACT, "[redacted]");
  return text.trim().split("\n").slice(-8).join("\n").slice(0, 2000);
}

function spawnGit(spawn, root, args) {
  return spawn("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function readGitState(root, spawn = spawnSync) {
  const head = spawnGit(spawn, root, ["rev-parse", "HEAD"]);
  if (head.status !== 0) {
    return { ok: false, reason: "missing-git-metadata", sourceCommit: null, branch: null, worktreeClean: false };
  }
  const sourceCommit = `${head.stdout ?? ""}`.trim();
  if (!COMMIT_SHA.test(sourceCommit)) {
    return { ok: false, reason: "invalid-git-commit", sourceCommit, branch: null, worktreeClean: false };
  }
  const branchResult = spawnGit(spawn, root, ["branch", "--show-current"]);
  const branch = `${branchResult.stdout ?? ""}`.trim() || "HEAD";
  const status = spawnGit(spawn, root, ["status", "--porcelain=v1"]);
  if (status.status !== 0) {
    return { ok: false, reason: "missing-git-metadata", sourceCommit, branch, worktreeClean: false };
  }
  const worktreeClean = `${status.stdout ?? ""}`.trim() === "";
  return { ok: true, reason: null, sourceCommit, branch, worktreeClean };
}

function environment() {
  return {
    nodeVersion: process.version,
    pnpmVersion: `${spawnSync("pnpm", ["--version"], { encoding: "utf8" }).stdout ?? ""}`.trim(),
  };
}

function atomicWriteJson(io, filePath, value) {
  const tmp = `${filePath}.tmp`;
  io.mkdir(dirname(filePath), { recursive: true });
  io.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  io.rename(tmp, filePath);
}

function writeReport(io, filePath, report) {
  atomicWriteJson(io, filePath, report);
}

function baseReport({ git, env, startedAt, decision, limitations, steps, finishedAt, skipBenchmarks, afterCoreIgnored }) {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    suite: REPORT_SUITE,
    sourceCommit: git.sourceCommit,
    branch: git.branch,
    worktreeClean: git.worktreeClean === true,
    decision,
    environment: env,
    startedAt,
    finishedAt,
    skipBenchmarks,
    afterCoreIgnored,
    steps,
    limitations,
  };
}

export function runVerify(options = {}) {
  const root = options.root ?? defaultRoot;
  const argv = options.argv ?? process.argv;
  const spawn = options.spawn ?? spawnSync;
  const now = options.now ?? (() => new Date().toISOString());
  const io = {
    mkdir: options.mkdir ?? mkdirSync,
    writeFile: options.writeFile ?? writeFileSync,
    rename: options.rename ?? renameSync,
    readFile: options.readFile ?? readFileSync,
  };
  const inspectPacks = options.inspectPacks ?? inspectReleasePacks;
  const assertPacks = options.assertPacks ?? assertPackInventory;
  const assertDocs = options.assertDocs ?? assertDocumentedCommands;
  const envInfo = options.environment ?? environment();
  const afterCoreRequested = argv.includes("--after-core");
  const skipBenchmarks = argv.includes("--skip-benchmarks") || options.env?.CI === "true" || process.env.CI === "true";
  const outFile = reportPath(root);
  const startedAt = now();
  const steps = [];
  const limitations = [
    PACK_SCAN_LIMITATION,
    "Ignored generated outputs (dist/, docs/release/out/, benchmarks/local-v1/out/) are not treated as Git authority.",
    "This verifier cannot record a verdict across uncatchable process termination or a filesystem that rejects the report write.",
  ];
  if (skipBenchmarks) limitations.push("Benchmarks skipped (CI=true or --skip-benchmarks); descriptive only, not a release SLO.");
  if (afterCoreRequested) {
    limitations.push("--after-core is deprecated and ignored; core.check always runs for a release verdict.");
  }

  const git = readGitState(root, spawn);
  const unfinished = baseReport({
    git,
    env: envInfo,
    startedAt,
    decision: DECISIONS.NOT_VERIFIED,
    limitations,
    steps,
    finishedAt: null,
    skipBenchmarks,
    afterCoreIgnored: afterCoreRequested,
  });

  const failClosed = (decision, extraLimitations = []) => {
    const finishedAt = now();
    const report = baseReport({
      git,
      env: envInfo,
      startedAt,
      decision,
      limitations: [...limitations, ...extraLimitations],
      steps,
      finishedAt,
      skipBenchmarks,
      afterCoreIgnored: afterCoreRequested,
    });
    try {
      writeReport(io, outFile, report);
      return { decision, report, exitCode: 1 };
    } catch {
      return { decision: DECISIONS.NOT_VERIFIED, report, exitCode: 1, writeFailed: true };
    }
  };

  try {
    writeReport(io, outFile, unfinished);
  } catch {
    return { decision: DECISIONS.NOT_VERIFIED, report: unfinished, exitCode: 1, writeFailed: true };
  }

  if (!git.ok) {
    steps.push({
      id: "git.preflight",
      command: "git rev-parse HEAD",
      exitCode: 1,
      passed: false,
      required: true,
      marker: null,
      tail: git.reason,
      evidence: null,
    });
    return failClosed(DECISIONS.NOT_VERIFIED, [`Git state is not verifiable (${git.reason}).`]);
  }
  if (!git.worktreeClean) {
    steps.push({
      id: "git.preflight",
      command: "git status --porcelain=v1",
      exitCode: 1,
      passed: false,
      required: true,
      marker: null,
      tail: "tracked or untracked worktree is not clean",
      evidence: null,
    });
    return failClosed(DECISIONS.NOT_VERIFIED, ["Dirty worktree cannot be certified as LOCAL_V1_READY."]);
  }
  steps.push({
    id: "git.preflight",
    command: "git rev-parse HEAD && git status --porcelain=v1",
    exitCode: 0,
    passed: true,
    required: true,
    marker: git.sourceCommit,
    tail: `${git.branch} clean`,
    evidence: null,
  });

  const run = (id, command, args, runOptions = {}) => {
    const result = spawn(command, args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CI: "true", ...options.env, ...runOptions.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const expected = runOptions.marker;
    const passed = result.status === 0 && (!expected || output.includes(expected));
    steps.push({
      id,
      command: [command, ...args].join(" "),
      exitCode: result.status,
      passed,
      required: true,
      marker: expected ?? null,
      tail: safeTail(output),
      evidence: runOptions.evidence ?? null,
    });
    return passed;
  };

  try {
    if (!run("core.check", "pnpm", ["check"])) return failClosed(DECISIONS.BLOCKED);

    for (const [id, args, marker] of FULL_SMOKES) {
      if (!run(id, "pnpm", args, { marker })) return failClosed(DECISIONS.BLOCKED);
    }

    const proofs = [
      "proof:company-research",
      "proof:document-intelligence",
      "proof:operational-request",
      "proof:company-portability",
      "proof:capability-packs",
      "proof:operator-inspection",
      "proof:security-hardening",
    ];
    for (const script of proofs) {
      if (!run(`proof.${script.replace("proof:", "")}`, "pnpm", [script])) return failClosed(DECISIONS.BLOCKED);
    }

    if (!run("consumer.sprint30", "pnpm", ["--filter", "@aao/example-release-consumer", "smoke:sprint30"], { marker: "SPRINT_30_LOCAL_V1_RELEASE_SMOKE_OK" })) {
      return failClosed(DECISIONS.BLOCKED);
    }

    if (!skipBenchmarks) {
      if (!run("benchmark.local-v1", "pnpm", ["benchmark:local-v1"], { marker: "AAO_LOCAL_V1_BENCHMARK_OK" })) {
        return failClosed(DECISIONS.BLOCKED);
      }
    }

    try {
      const packs = assertPacks(inspectPacks(root));
      steps.push({
        id: "pack.inventory",
        command: "scripts/pack-inventory.mjs",
        exitCode: 0,
        passed: true,
        required: true,
        marker: null,
        tail: `${packs.length} packages inspected`,
        evidence: null,
      });
    } catch (error) {
      steps.push({
        id: "pack.inventory",
        command: "scripts/pack-inventory.mjs",
        exitCode: 1,
        passed: false,
        required: true,
        marker: null,
        tail: safeTail(error instanceof Error ? error.message : "pack inventory failed"),
        evidence: null,
      });
      return failClosed(DECISIONS.BLOCKED);
    }

    try {
      const commands = assertDocs(root);
      steps.push({
        id: "docs.commands",
        command: "scripts/documented-commands.mjs",
        exitCode: 0,
        passed: true,
        required: true,
        marker: null,
        tail: `${commands.scripts.length} scripts`,
        evidence: null,
      });
    } catch (error) {
      steps.push({
        id: "docs.commands",
        command: "scripts/documented-commands.mjs",
        exitCode: 1,
        passed: false,
        required: true,
        marker: null,
        tail: safeTail(error instanceof Error ? error.message : "documented commands failed"),
        evidence: null,
      });
      return failClosed(DECISIONS.BLOCKED);
    }

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
    for (const relative of requiredDocs) io.readFile(join(root, relative), "utf8");
    steps.push({
      id: "docs.required",
      command: "required release docs",
      exitCode: 0,
      passed: true,
      required: true,
      marker: null,
      tail: requiredDocs.join(","),
      evidence: null,
    });
  } catch (error) {
    steps.push({
      id: "verifier.exception",
      command: "scripts/release-verify-local-v1.mjs",
      exitCode: 1,
      passed: false,
      required: true,
      marker: null,
      tail: safeTail(error instanceof Error ? error.message : "unexpected verifier exception"),
      evidence: null,
    });
    try {
      return failClosed(DECISIONS.NOT_VERIFIED, ["Qualification ended in an unexpected exception."]);
    } catch {
      return { decision: DECISIONS.NOT_VERIFIED, report: unfinished, exitCode: 1, writeFailed: true };
    }
  }

  const after = readGitState(root, spawn);
  if (!after.ok || after.sourceCommit !== git.sourceCommit) {
    steps.push({
      id: "git.postflight",
      command: "git rev-parse HEAD",
      exitCode: 1,
      passed: false,
      required: true,
      marker: git.sourceCommit,
      tail: "HEAD changed during qualification or Git metadata is missing",
      evidence: null,
    });
    return failClosed(DECISIONS.NOT_VERIFIED, ["HEAD changed during qualification; the verdict is not bound to one commit."]);
  }
  if (!after.worktreeClean) {
    steps.push({
      id: "git.postflight",
      command: "git status --porcelain=v1",
      exitCode: 1,
      passed: false,
      required: true,
      marker: git.sourceCommit,
      tail: "tracked source changed during qualification",
      evidence: null,
    });
    return failClosed(DECISIONS.NOT_VERIFIED, ["Tracked worktree changed during qualification."]);
  }
  steps.push({
    id: "git.postflight",
    command: "git rev-parse HEAD && git status --porcelain=v1",
    exitCode: 0,
    passed: true,
    required: true,
    marker: after.sourceCommit,
    tail: "source commit unchanged; worktree clean",
    evidence: reportPath(root),
  });

  const failed = steps.filter((step) => !step.passed);
  const decision = failed.length === 0 ? DECISIONS.READY : DECISIONS.BLOCKED;
  const report = baseReport({
    git: after,
    env: envInfo,
    startedAt,
    decision,
    limitations,
    steps,
    finishedAt: now(),
    skipBenchmarks,
    afterCoreIgnored: afterCoreRequested,
  });
  try {
    writeReport(io, outFile, report);
  } catch {
    return { decision: DECISIONS.NOT_VERIFIED, report, exitCode: 1, writeFailed: true };
  }
  return { decision, report, exitCode: decision === DECISIONS.READY ? 0 : 1 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runVerify({ root: defaultRoot, argv: process.argv });
  if (result.report) {
    process.stdout.write(`${JSON.stringify({ decision: result.decision, sourceCommit: result.report.sourceCommit, steps: result.report.steps.map((step) => ({ id: step.id, passed: step.passed })) }, null, 2)}\n`);
  }
  process.stdout.write(`${result.decision}\n`);
  process.exitCode = result.exitCode;
}
