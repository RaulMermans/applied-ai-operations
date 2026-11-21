import { getContainerRuntimeClient } from "testcontainers";
import { describe, expect, it } from "vitest";
import { COMPATIBLE_EXPAND, INCOMPATIBLE_RENAME, type Scenario } from "../src/fixtures/payment-ledger.js";
import { buildReport, rehearse, runAllowlistedScenario } from "../src/runner/rehearsal.js";
import { startEphemeralPostgres, type Database } from "../src/runner/postgres.js";

// Real, ephemeral PostgreSQL 16 via Docker. Run: pnpm --filter @aao/reverse test:integration

/** Wraps the real starter to independently observe port binding and removal. */
function observed() {
  const ids: string[] = [];
  const bindings: string[] = [];
  const startDatabase = async (): Promise<Database> => {
    const db = await startEphemeralPostgres();
    ids.push(db.containerId as string);
    const client = await getContainerRuntimeClient();
    const info = await client.container.inspect(client.container.getById(db.containerId as string));
    for (const list of Object.values(info.HostConfig.PortBindings ?? {})) for (const b of list as { HostIp: string }[]) bindings.push(b.HostIp);
    return db;
  };
  const allRemoved = async () => {
    const client = await getContainerRuntimeClient();
    const states = await Promise.all(ids.map((id) => client.container.inspect(client.container.getById(id)).then(() => "present", (e: { statusCode?: number }) => (e.statusCode === 404 ? "removed" : "unknown"))));
    return ids.length > 0 && states.every((s) => s === "removed");
  };
  return { startDatabase, bindings, allRemoved };
}

describe("RollbackProof on real PostgreSQL 16", () => {
  it("Scenario A: incompatible rename migrates, v2 works, v1 breaks -> evidence-backed FAIL", async () => {
    const o = observed();
    const { execution, containerRemoved } = await rehearse(INCOMPATIBLE_RENAME, { startDatabase: o.startDatabase });
    const step = (id: string) => execution.steps.find((s) => s.id === id);
    expect(execution.status).toBe("COMPLETED");
    expect(execution.postgres_version).toMatch(/^16\./);
    expect(step("v1_pre_read")).toMatchObject({ ok: true });
    expect(step("migration")).toMatchObject({ ok: true });
    expect(step("v2_write")).toMatchObject({ ok: true });
    expect(step("v2_read")).toMatchObject({ ok: true });
    expect(step("v1_post_read")).toMatchObject({ ok: false, sqlstate: "42703" });

    const report = buildReport(INCOMPATIBLE_RENAME, execution, containerRemoved);
    expect(report).toMatchObject({ result: "FAIL", expectation: { expected_result: "FAIL", met: true }, cleanup: { container_removed: true } });
    expect(report.failed_invariants).toEqual(["V1_WRITE_ACCEPTED", "V1_READ_ACCEPTED", "V1_RECORDS_ACCESSIBLE", "V1_DECLARED_TOTAL_PRESERVED"]);
    expect(o.bindings).toEqual(["127.0.0.1"]);
    expect(await o.allRemoved()).toBe(true);
  });

  it("Scenario B: expand migration keeps v1 working and totals intact -> evidence-backed PASS", async () => {
    const o = observed();
    const report = await runAllowlistedScenario(COMPATIBLE_EXPAND.id, { startDatabase: o.startDatabase });
    expect(report).toMatchObject({ result: "PASS", execution_status: "COMPLETED", expectation: { met: true }, cleanup: { container_removed: true } });
    expect(report.verified_invariants).toEqual(["V1_BASELINE_READ", "V1_WRITE_ACCEPTED", "V1_READ_ACCEPTED", "V1_RECORDS_ACCESSIBLE", "V1_DECLARED_TOTAL_PRESERVED"]);
    expect(await o.allRemoved()).toBe(true);
  });

  it("is reproducible: repeated runs give identical verdicts and evidence", async () => {
    const fp = async (id: string) => {
      const r = await runAllowlistedScenario(id);
      return JSON.stringify([r.fixture_digest, r.result, r.reason_codes, r.verified_invariants, r.failed_invariants, r.cleanup]);
    };
    for (const id of [INCOMPATIBLE_RENAME.id, COMPATIBLE_EXPAND.id]) expect(await fp(id)).toBe(await fp(id));
  });

  it.each([
    ["syntax error", "ALTR TABLE ledger_entries ADD COLUMN x INT"],
    ["unknown column", "ALTER TABLE ledger_entries RENAME COLUMN does_not_exist TO x"],
  ])("invalid migration SQL (%s) is INCONCLUSIVE MIGRATION_REJECTED, never PASS", async (_n, sql) => {
    const broken: Scenario = { ...COMPATIBLE_EXPAND, id: "broken-migration", migration: [sql] };
    const { execution, containerRemoved } = await rehearse(broken);
    expect(buildReport(broken, execution, containerRemoved)).toMatchObject({ result: "INCONCLUSIVE", reason_codes: ["MIGRATION_REJECTED"], cleanup: { container_removed: true } });
  });

  it("a statement exceeding the timeout aborts the run as INCONCLUSIVE and still cleans up", async () => {
    const slow: Scenario = { ...COMPATIBLE_EXPAND, id: "slow-migration", migration: ["SELECT pg_sleep(5)"] };
    const { execution, containerRemoved } = await rehearse(slow, { statementTimeoutMs: 300 });
    expect(execution).toMatchObject({ status: "ABORTED", abort_reason: "TIMEOUT" });
    expect(buildReport(slow, execution, containerRemoved)).toMatchObject({ result: "INCONCLUSIVE", reason_codes: ["EXECUTION_ABORTED:TIMEOUT"], cleanup: { container_removed: true } });
  });
});
