import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SECURITY_CASES } from "../../security-hardening/src/index.js";
import { demonstrateFrameworkApprovalRestartLimitation, runGoldenPath, runPackAdoptionJourney } from "../src/index.js";

const REQUIRED_SCRIPTS = [
  "check",
  "benchmark:local-v1",
  "release:verify:local-v1",
  "proof:security-hardening",
  "eval:ci",
] as const;

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("Local V1 golden path", () => {
  it("completes an authorized read-only workflow, refuses unauthorized tools, and writes one approved draft", async () => {
    const result = await runGoldenPath();
    expect(result.authorized.status).toBe("COMPLETED");
    expect(result.authorized.lookupCalls).toBe(1);
    expect(result.denied.executorFailure).toBe("TOOL_AUTHORIZATION_DENIED");
    expect(result.denied.lookupCalls).toBe(0);
    expect(result.approval.waitingStatus).toBe("WAITING_FOR_APPROVAL");
    expect(result.approval.draftCallsWhileWaiting).toBe(0);
    expect(result.approval.completedStatus).toBe("COMPLETED");
    expect(result.approval.draftCalls).toBe(1);
    expect(result.approval.duplicateOk).toBe(false);
    expect(result.evidence.inspectionStatus).toBe("COMPLETED");
    expect(result.evidence.missingStatus).toBe("UNKNOWN");
    expect(result.evaluation.ok).toBe(true);
    expect(result.evaluation.statuses).toEqual(["passed"]);
  });

  it("fails closed when an Approval-waiting Framework Run is continued after a process-local restart", async () => {
    const result = await demonstrateFrameworkApprovalRestartLimitation();
    expect(result.waitingStatus).toBe("WAITING_FOR_APPROVAL");
    expect(result.restartedOk).toBe(false);
    expect(result.restartedFailure).toBe("INVALID_APPROVAL_CONTEXT");
    expect(result.draftCalls).toBe(0);
  });
});

describe("Capability Pack adoption", () => {
  it("activates the three canonical packs with verified registration evidence and keeps demo NOT_VERIFIED distinct", async () => {
    const result = await runPackAdoptionJourney();
    expect(result.packCount).toBe(3);
    expect(result.northstarCompatible).toBe(true);
    expect(result.arborCompatible).toBe(true);
    expect(result.fingerprintsMatch).toBe(true);
    expect(result.executedStatus).toBe("completed");
    expect(result.demoUnverified).toBe(true);
    expect(result.missingEvidenceStatus).toBe("NOT_VERIFIED");
    expect(result.verifiedEvidenceStatus).toBe("COMPATIBLE");
  });
});

describe("release contracts", () => {
  it("keeps the supported distribution private and unpublished", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.private).toBe(true);
    expect(pkg.version).toBe("0.0.0");
    expect(pkg.engines.node).toBe(">=20.20.0 <21.0.0");
    for (const name of REQUIRED_SCRIPTS) {
      expect(pkg.scripts[name], name).toEqual(expect.any(String));
    }
  });

  it("does not claim npm publication in the Local V1 limitations", () => {
    const limitations = readFileSync(join(root, "docs/release/local-v1-limitations.md"), "utf8");
    expect(limitations).toMatch(/not published to npm/i);
    expect(limitations).toMatch(/Approval-waiting/i);
    expect(limitations).not.toMatch(/npm publish succeeded/i);
  });

  it("includes Sprint 29C continuation-ownership and Audit cases in the security suite", () => {
    const ids = new Set(SECURITY_CASES.map((securityCase) => securityCase.id));
    expect(ids.has("continuation.other-requester-same-role-refused")).toBe(true);
    expect(ids.has("continuation.fresh-attestation-same-principal")).toBe(true);
    expect(ids.has("audit.company-research-tool-access")).toBe(true);
    expect(ids.has("audit.sink-failure-does-not-bypass-or-duplicate")).toBe(true);
    expect(SECURITY_CASES.length).toBeGreaterThanOrEqual(40);
  });

  it("wires Local V1 release verification into CI", () => {
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain("pnpm release:verify:local-v1");
    expect(ci).not.toContain("--after-core");
    expect(ci).not.toContain("npm publish");
  });

  it("computes nearest-rank percentiles without invented samples", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
    expect(percentile([], 50)).toBeNull();
  });
});
