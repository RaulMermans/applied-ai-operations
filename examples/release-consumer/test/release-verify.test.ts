import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DECISIONS, reportPath, runVerify } from "../../../scripts/release-verify-local-v1.mjs";

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MARKERS = [
  "SPRINT_18_EVAL_ANALYTICS_CI_ADAPTER_VERIFICATION_SMOKE_OK",
  "SPRINT_19_FRAMEWORK_SURFACE_SMOKE_OK",
  "SPRINT_20_ADAPTER_PORTABILITY_CONTRACT_SMOKE_OK",
  "SPRINT_21_TOOLBOX_FOUNDATION_SMOKE_OK",
  "SPRINT_22_COMPANY_RESEARCH_PROOF_SMOKE_OK",
  "SPRINT_23_DOCUMENT_INTELLIGENCE_PROOF_SMOKE_OK",
  "SPRINT_24_OPERATIONAL_REQUEST_PROOF_SMOKE_OK",
  "SPRINT_25_COMPANY_PORTABILITY_PROOF_SMOKE_OK",
  "SPRINT_26_CAPABILITY_PACKS_SMOKE_OK",
  "SPRINT_27_OPERATOR_INSPECTION_SMOKE_OK",
  "SPRINT_28_GUIDED_INTEGRATION_RUN_INSPECTOR_SMOKE_OK",
  "SPRINT_29_SECURITY_IDENTITY_ADAPTER_HARDENING_SMOKE_OK",
  "SPRINT_30_LOCAL_V1_RELEASE_SMOKE_OK",
  "AAO_LOCAL_V1_BENCHMARK_OK",
].join("\n");

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function readyReport(sourceCommit = SHA_A) {
  return {
    schemaVersion: 2,
    suite: "aao.release.verify.local-v1",
    sourceCommit,
    decision: DECISIONS.READY,
    steps: [{ id: "core.check", passed: true }],
  };
}

function spawnFor({
  sha = SHA_A,
  secondSha,
  porcelain = "",
  gitStatus = 0,
  failHead = false,
  failStep,
}: {
  sha?: string;
  secondSha?: string;
  porcelain?: string;
  gitStatus?: number;
  failHead?: boolean;
  failStep?: "check" | "proof:security-hardening" | string;
} = {}) {
  let heads = 0;
  return (command: string, args: string[]) => {
    if (command === "git") {
      if (args[0] === "rev-parse") {
        heads += 1;
        if (failHead) return { status: 128, stdout: "", stderr: "fatal: not a git repository" };
        const out = secondSha && heads > 1 ? secondSha : sha;
        return { status: 0, stdout: `${out}\n`, stderr: "" };
      }
      if (args[0] === "branch") return { status: 0, stdout: "sprint-30-local-v1\n", stderr: "" };
      if (args[0] === "status") return { status: gitStatus, stdout: porcelain, stderr: gitStatus === 0 ? "" : "status failed" };
      return { status: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
    }
    if (command === "pnpm") {
      const joined = args.join(" ");
      if (failStep === "check" && args.includes("check")) return { status: 1, stdout: "", stderr: "core check failed" };
      if (failStep && failStep !== "check" && joined.includes(failStep)) return { status: 1, stdout: "", stderr: `${failStep} failed` };
      return { status: 0, stdout: `${MARKERS}\n`, stderr: "" };
    }
    return { status: 1, stdout: "", stderr: `unexpected ${command}` };
  };
}

function verifyOpts(root: string, overrides: Record<string, unknown> = {}) {
  return {
    root,
    argv: ["node", "scripts/release-verify-local-v1.mjs"],
    env: { CI: "true" },
    environment: { nodeVersion: "v20.20.2", pnpmVersion: "10.26.0" },
    inspectPacks: () => [{ name: "@aao/framework", findings: [], unexpected: [], files: ["package/package.json"] }],
    assertPacks: (reports: unknown) => reports,
    assertDocs: () => ({ scripts: ["check"], missing: [], undocumented: [] }),
    readFile: () => "ok",
    ...overrides,
  };
}

function newRoot() {
  const root = mkdtempSync(join(tmpdir(), "aao-verify-"));
  temps.push(root);
  mkdirSync(join(root, "docs/release/out"), { recursive: true });
  return root;
}

function readDecision(root: string) {
  return JSON.parse(readFileSync(reportPath(root), "utf8")) as { decision: string; sourceCommit: string | null; steps: Array<{ id: string; passed: boolean }> };
}

describe("release verifier", () => {
  it("records READY only after a passing same-revision core check", () => {
    const root = newRoot();
    const result = runVerify({ ...verifyOpts(root), spawn: spawnFor() });
    expect(result.decision).toBe(DECISIONS.READY);
    expect(result.exitCode).toBe(0);
    const report = readDecision(root);
    expect(report.sourceCommit).toBe(SHA_A);
    expect(report.steps.some((step) => step.id === "core.check" && step.passed)).toBe(true);
  });

  it("still runs core.check when --after-core is passed and does not skip evidence", () => {
    const root = newRoot();
    const commands: string[] = [];
    const spawn = spawnFor();
    const wrapped = (command: string, args: string[]) => {
      commands.push([command, ...args].join(" "));
      return spawn(command, args);
    };
    const result = runVerify({
      ...verifyOpts(root),
      argv: ["node", "scripts/release-verify-local-v1.mjs", "--after-core"],
      spawn: wrapped,
    });
    expect(commands.some((line) => line === "pnpm check")).toBe(true);
    expect(result.decision).toBe(DECISIONS.READY);
    expect(result.report.afterCoreIgnored).toBe(true);
  });

  it("produces no READY when the core check fails", () => {
    const root = newRoot();
    const result = runVerify({ ...verifyOpts(root), spawn: spawnFor({ failStep: "check" }) });
    expect(result.decision).toBe(DECISIONS.BLOCKED);
    expect(readDecision(root).decision).toBe(DECISIONS.BLOCKED);
    expect(readDecision(root).steps.find((step) => step.id === "core.check")?.passed).toBe(false);
  });

  it("produces no READY when the security proof fails", () => {
    const root = newRoot();
    const result = runVerify({ ...verifyOpts(root), spawn: spawnFor({ failStep: "proof:security-hardening" }) });
    expect(result.decision).toBe(DECISIONS.BLOCKED);
    expect(readDecision(root).decision).not.toBe(DECISIONS.READY);
  });

  it("produces no READY when package inventory fails", () => {
    const root = newRoot();
    const result = runVerify({
      ...verifyOpts(root),
      spawn: spawnFor(),
      assertPacks: () => {
        throw new Error("packed artifacts failed inventory: @aao/x package/extra.js unexpected-path");
      },
    });
    expect(result.decision).toBe(DECISIONS.BLOCKED);
    expect(readDecision(root).steps.find((step) => step.id === "pack.inventory")?.passed).toBe(false);
  });

  it("produces no READY when documentation checks fail", () => {
    const root = newRoot();
    const result = runVerify({
      ...verifyOpts(root),
      spawn: spawnFor(),
      assertDocs: () => {
        throw new Error("required scripts are undocumented: lint");
      },
    });
    expect(result.decision).toBe(DECISIONS.BLOCKED);
    expect(readDecision(root).steps.find((step) => step.id === "docs.commands")?.passed).toBe(false);
  });

  it("returns NOT_VERIFIED when Git metadata is missing", () => {
    const root = newRoot();
    const result = runVerify({ ...verifyOpts(root), spawn: spawnFor({ failHead: true }) });
    expect(result.decision).toBe(DECISIONS.NOT_VERIFIED);
    expect(readDecision(root).decision).toBe(DECISIONS.NOT_VERIFIED);
  });

  it("cannot certify a dirty tracked worktree as READY", () => {
    const root = newRoot();
    const result = runVerify({ ...verifyOpts(root), spawn: spawnFor({ porcelain: " M packages/framework/package.json\n" }) });
    expect(result.decision).toBe(DECISIONS.NOT_VERIFIED);
    expect(readDecision(root).decision).not.toBe(DECISIONS.READY);
  });

  it("refuses when HEAD changes during verification", () => {
    const root = newRoot();
    const result = runVerify({ ...verifyOpts(root), spawn: spawnFor({ secondSha: SHA_B }) });
    expect(result.decision).toBe(DECISIONS.NOT_VERIFIED);
    expect(readDecision(root).steps.some((step) => step.id === "git.postflight" && !step.passed)).toBe(true);
  });

  it("invalidates a previous READY report when a new attempt fails", () => {
    const root = newRoot();
    writeFileSync(reportPath(root), `${JSON.stringify(readyReport(), null, 2)}\n`);
    const result = runVerify({ ...verifyOpts(root), spawn: spawnFor({ failStep: "check" }) });
    expect(result.decision).toBe(DECISIONS.BLOCKED);
    expect(readDecision(root).decision).toBe(DECISIONS.BLOCKED);
  });

  it("does not leave a current successful verdict after an unexpected exception", () => {
    const root = newRoot();
    writeFileSync(reportPath(root), `${JSON.stringify(readyReport(), null, 2)}\n`);
    const result = runVerify({
      ...verifyOpts(root),
      spawn: spawnFor(),
      readFile: () => {
        throw new Error("docs unreadable");
      },
    });
    expect(result.decision).toBe(DECISIONS.NOT_VERIFIED);
    expect(readDecision(root).decision).toBe(DECISIONS.NOT_VERIFIED);
  });

  it("exits nonzero when the report cannot be written", () => {
    const root = newRoot();
    const result = runVerify({
      ...verifyOpts(root),
      spawn: spawnFor(),
      writeFile: () => {
        throw new Error("ENOSPC");
      },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.writeFailed).toBe(true);
    expect(result.decision).toBe(DECISIONS.NOT_VERIFIED);
  });

  it("does not reuse invalid prior READY evidence", () => {
    const root = newRoot();
    writeFileSync(reportPath(root), `${JSON.stringify({ decision: DECISIONS.READY, steps: [{ id: "core.check", passed: false }] }, null, 2)}\n`);
    const result = runVerify({ ...verifyOpts(root), spawn: spawnFor({ failHead: true }) });
    expect(result.decision).toBe(DECISIONS.NOT_VERIFIED);
    expect(readDecision(root).decision).toBe(DECISIONS.NOT_VERIFIED);
    expect(readDecision(root).schemaVersion).toBe(2);
  });
});
