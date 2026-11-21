import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STEP_IDS, VerificationReportSchema, type Execution, type StepOutcome } from "../src/domain/contract.js";
import { evaluate } from "../src/domain/evaluate.js";
import { COMPATIBLE_EXPAND, INCOMPATIBLE_RENAME, SCENARIOS } from "../src/fixtures/payment-ledger.js";
import { buildReport, fixtureDigest, redact, rehearse, runAllowlistedScenario } from "../src/runner/rehearsal.js";
import { MALFORMED_MESSAGE, PROBE_MESSAGE, rollbackProofProbe } from "../forge/src/index.js";

// Docker-free unit tests (run in the root `pnpm test`). Real PostgreSQL runs live in ../integration.

const seedRows = COMPATIBLE_EXPAND.seed_v1.map((r) => ({ ...r, amount_cents: String(r.amount_cents) }));
const allRows = [
  ...seedRows,
  ...COMPATIBLE_EXPAND.v2_writes.map((r) => ({ id: r.id, account_id: r.account_id, amount_cents: String(r.amount_minor), currency: r.currency })),
  ...COMPATIBLE_EXPAND.v1_post_writes.map((r) => ({ ...r, amount_cents: String(r.amount_cents) })),
];

function execution(overrides: Partial<Record<(typeof STEP_IDS)[number], StepOutcome | null>> = {}): Execution {
  const ok: Record<string, StepOutcome> = Object.fromEntries(STEP_IDS.map((id) => [id, { id, ok: true }]));
  ok.v1_pre_read = { id: "v1_pre_read", ok: true, rows: seedRows };
  ok.v1_post_read = { id: "v1_post_read", ok: true, rows: allRows };
  const steps = STEP_IDS.map((id) => (id in overrides ? overrides[id] : ok[id])).filter((s): s is StepOutcome => s !== null && s !== undefined);
  return { status: "COMPLETED", abort_reason: null, steps, postgres_version: "16.10", started_at: "2026-11-21T00:00:00.000Z", completed_at: "2026-11-21T00:00:01.000Z" };
}
const rejected = (id: (typeof STEP_IDS)[number], sqlstate: string | null) => ({ id, ok: false as const, sqlstate, message: "synthetic" });

describe("RollbackProof evaluator", () => {
  it("returns PASS only when every v1 invariant is verified", () => {
    const e = evaluate(COMPATIBLE_EXPAND, execution());
    expect(e).toEqual({ result: "PASS", reason_codes: [], verified_invariants: ["V1_BASELINE_READ", "V1_WRITE_ACCEPTED", "V1_READ_ACCEPTED", "V1_RECORDS_ACCESSIBLE", "V1_DECLARED_TOTAL_PRESERVED"], failed_invariants: [] });
  });

  it("returns FAIL when v1 can no longer read or write after the migration", () => {
    const e = evaluate(INCOMPATIBLE_RENAME, execution({ v1_post_write: rejected("v1_post_write", "42703"), v1_post_read: rejected("v1_post_read", "42703") }));
    expect(e.result).toBe("FAIL");
    expect(e.reason_codes).toEqual(["V1_WRITE_REJECTED:42703", "V1_READ_REJECTED:42703", "V1_RECORDS_NOT_ACCESSIBLE", "V1_DECLARED_TOTAL_MISMATCH"]);
  });

  it("returns FAIL when v1 reads succeed but the declared monetary total drifts", () => {
    const drifted = allRows.map((r) => (r.id === 4 ? { ...r, amount_cents: "3100" } : r));
    const e = evaluate(COMPATIBLE_EXPAND, execution({ v1_post_read: { id: "v1_post_read", ok: true, rows: drifted } }));
    expect(e).toMatchObject({ result: "FAIL", failed_invariants: ["V1_DECLARED_TOTAL_PRESERVED"] });
  });

  it("never treats a successful migration alone as PASS", () => {
    expect(evaluate(COMPATIBLE_EXPAND, execution({ v1_post_read: null })).result).toBe("INCONCLUSIVE");
  });

  it.each([
    ["missing evidence", execution({ v2_read: null }), "EVIDENCE_MISSING:v2_read"],
    ["aborted execution", { ...execution(), status: "ABORTED", abort_reason: "TIMEOUT" } as Execution, "EXECUTION_ABORTED:TIMEOUT"],
    ["connection loss during v1 read", execution({ v1_post_read: rejected("v1_post_read", "08006") }), "INFRA_FAILURE:v1_post_read"],
    ["statement timeout during v1 read", execution({ v1_post_read: rejected("v1_post_read", "57014") }), "INFRA_FAILURE:v1_post_read"],
    ["transport error without SQLSTATE", execution({ v1_post_write: rejected("v1_post_write", null) }), "INFRA_FAILURE:v1_post_write"],
    ["invalid migration SQL", execution({ migration: rejected("migration", "42601") }), "MIGRATION_REJECTED"],
    ["broken fixture baseline", execution({ v1_pre_read: { id: "v1_pre_read", ok: true, rows: [] } }), "FIXTURE_PRECONDITION_FAILED"],
    ["v2 contract not exercised", execution({ v2_write: rejected("v2_write", "42703") }), "V2_CONTRACT_NOT_EXERCISED"],
  ])("returns INCONCLUSIVE (never PASS or FAIL) for %s", (_name, exec, reason) => {
    const e = evaluate(COMPATIBLE_EXPAND, exec);
    expect(e.result).toBe("INCONCLUSIVE");
    expect(e.reason_codes).toContain(reason);
  });

  it("is deterministic for identical input", () => {
    const exec = execution({ v1_post_read: rejected("v1_post_read", "42703") });
    expect(evaluate(INCOMPATIBLE_RENAME, exec)).toEqual(evaluate(INCOMPATIBLE_RENAME, structuredClone(exec)));
  });
});

describe("verification report contract", () => {
  it("builds schema-valid reports labelled as local fixtures, never with a commit SHA", () => {
    const report = buildReport(COMPATIBLE_EXPAND, execution(), true);
    expect(VerificationReportSchema.safeParse(report).success).toBe(true);
    expect(report.source).toEqual({ kind: "local_fixture", commit_sha: null });
    expect(report.fixture_digest).toBe(fixtureDigest(structuredClone(COMPATIBLE_EXPAND)));
    expect(fixtureDigest(COMPATIBLE_EXPAND)).not.toBe(fixtureDigest(INCOMPATIBLE_RENAME));
  });

  it("rejects internally inconsistent verdicts", () => {
    const pass = buildReport(COMPATIBLE_EXPAND, execution(), true);
    expect(VerificationReportSchema.safeParse({ ...pass, failed_invariants: ["V1_READ_ACCEPTED"] }).success).toBe(false);
    expect(VerificationReportSchema.safeParse({ ...pass, result: "FAIL" }).success).toBe(false);
    expect(VerificationReportSchema.safeParse({ ...pass, result: "INCONCLUSIVE", reason_codes: [] }).success).toBe(false);
    expect(VerificationReportSchema.safeParse({ ...pass, source: { kind: "local_fixture", commit_sha: "a".repeat(40) } }).success).toBe(false);
  });

  it("redacts connection strings and passwords", () => {
    expect(redact("connect postgres://u:secret@127.0.0.1:5432/db failed password=hunter2")).toBe("connect postgres://[redacted] failed password=[redacted]");
  });
});

describe("runner failure classification (no Docker)", () => {
  it("classifies a failed container start as INCONCLUSIVE", async () => {
    const { execution: exec, containerRemoved } = await rehearse(COMPATIBLE_EXPAND, { startDatabase: () => Promise.reject(new Error("docker unavailable")) });
    expect(exec).toMatchObject({ status: "ABORTED", abort_reason: "CONTAINER_START_FAILED", steps: [] });
    expect(containerRemoved).toBeNull();
    expect(buildReport(COMPATIBLE_EXPAND, exec, containerRemoved).result).toBe("INCONCLUSIVE");
  });

  it("classifies an unreachable database as INCONCLUSIVE and still stops it", async () => {
    let stopped = false;
    const { execution: exec, containerRemoved } = await rehearse(INCOMPATIBLE_RENAME, {
      startDatabase: async () => ({ connectionUri: "postgres://x:y@127.0.0.1:1/none", containerId: null, stop: async () => { stopped = true; return true; } }),
    });
    expect(exec.abort_reason).toBe("DATABASE_UNAVAILABLE");
    expect(stopped && containerRemoved).toBe(true);
    expect(buildReport(INCOMPATIBLE_RENAME, exec, containerRemoved).result).toBe("INCONCLUSIVE");
  });

  it("classifies a runner timeout as INCONCLUSIVE and stops a late-starting database", async () => {
    let lateStop = false;
    const late = new Promise<never>(() => undefined);
    const { execution: exec } = await rehearse(COMPATIBLE_EXPAND, { timeoutMs: 50, startDatabase: () => late });
    expect(exec).toMatchObject({ status: "ABORTED", abort_reason: "TIMEOUT" });
    expect(buildReport(COMPATIBLE_EXPAND, exec, null).result).toBe("INCONCLUSIVE");

    let resolveStart!: (d: { connectionUri: string; containerId: null; stop: () => Promise<boolean> }) => void;
    const slow = new Promise<{ connectionUri: string; containerId: null; stop: () => Promise<boolean> }>((r) => { resolveStart = r; });
    await rehearse(COMPATIBLE_EXPAND, { timeoutMs: 20, startDatabase: () => slow });
    resolveStart({ connectionUri: "postgres://unused", containerId: null, stop: async () => { lateStop = true; return true; } });
    await new Promise((r) => setTimeout(r, 10));
    expect(lateStop).toBe(true);
  });

  it("refuses scenarios outside the allowlist", async () => {
    await expect(runAllowlistedScenario("drop-everything")).rejects.toThrow(/not allowlisted/);
    expect(Object.keys(SCENARIOS)).toEqual([INCOMPATIBLE_RENAME.id, COMPATIBLE_EXPAND.id]);
  });
});

describe("Forge merge-check probe contract (local only; not a deployment)", () => {
  const event = { workspace: { uuid: "{ws}" }, repository: { uuid: "{repo}" }, pullrequest: { id: 7 }, trigger: { type: "on-code-pushed" } };

  it("returns a deterministic response that does not claim RollbackProof ran", async () => {
    await expect(rollbackProofProbe(event)).resolves.toEqual({ success: true, message: PROBE_MESSAGE });
    expect(PROBE_MESSAGE).toMatch(/NOT evaluated/);
  });

  it("fails closed on a malformed payload", async () => {
    await expect(rollbackProofProbe({ ...event, trigger: { type: "on-something-else" } })).resolves.toEqual({ success: false, message: MALFORMED_MESSAGE });
    await expect(rollbackProofProbe({} as never)).resolves.toMatchObject({ success: false });
  });
});

describe("AAO boundary", () => {
  it("no AAO package depends on Atlassian, Forge, PostgreSQL or Testcontainers", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    for (const dir of ["packages", "examples"]) {
      for (const name of readdirSync(join(root, dir))) {
        const manifestPath = join(root, dir, name, "package.json");
        if (!existsSync(manifestPath)) continue;
        const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, Record<string, string> | undefined>;
        const deps = Object.keys({ ...m.dependencies, ...m.devDependencies, ...m.peerDependencies });
        expect(deps.filter((d) => /^(pg|@forge\/|@atlassian|testcontainers|@testcontainers\/)/.test(d)), `${dir}/${name}`).toEqual([]);
      }
    }
  });
});
