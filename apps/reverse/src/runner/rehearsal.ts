import { createHash } from "node:crypto";
import pg from "pg";
import { canonicalJsonStringify, type JsonValue } from "@aao/contracts";
import { SCENARIOS, V1, V2, type Scenario } from "../fixtures/payment-ledger.js";
import { VerificationReportSchema, isInfraFailure, type AbortReason, type Execution, type StepId, type StepOutcome, type VerificationReport } from "../domain/contract.js";
import { evaluate } from "../domain/evaluate.js";
import { POSTGRES_IMAGE, startEphemeralPostgres, type Database, type StartDatabase } from "./postgres.js";

export const RUNNER_VERSION = "reverse-rollbackproof-runner/0.1.0";

export type RehearsalOptions = {
  startDatabase?: StartDatabase;
  /** Wall-clock budget for the whole rehearsal, including container start. */
  timeoutMs?: number;
  /** Server-side per-statement limit (SQLSTATE 57014 on breach). */
  statementTimeoutMs?: number;
  now?: () => Date;
};

export function fixtureDigest(scenario: Scenario): string {
  const json = canonicalJsonStringify({ scenario, v1: V1, v2: V2 } as unknown as JsonValue);
  return `sha256:${createHash("sha256").update(json).digest("hex")}`;
}

/** Strip connection URIs and credentials before anything reaches a report or log. */
export function redact(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://[redacted]").replace(/password\s*[=:]\s*\S+/gi, "password=[redacted]").slice(0, 500);
}

const sqlstateOf = (error: unknown): string | null => {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
};

function plan(scenario: Scenario): [StepId, (c: pg.Client) => Promise<Record<string, unknown>[] | undefined>][] {
  const each = <T>(items: T[], sql: string, args: (t: T) => unknown[]) => async (c: pg.Client) => {
    for (const item of items) await c.query(sql, args(item));
    return undefined;
  };
  const v1Args = (r: Scenario["seed_v1"][number]) => [r.id, r.account_id, r.amount_cents, r.currency];
  return [
    ["schema_v1", async (c) => { for (const sql of scenario.schema_v1) await c.query(sql); return undefined; }],
    ["seed_v1", each(scenario.seed_v1, V1.write, v1Args)],
    ["v1_pre_read", async (c) => (await c.query(V1.read)).rows],
    ["migration", async (c) => {
      await c.query("BEGIN");
      try {
        for (const sql of scenario.migration) await c.query(sql);
        await c.query("COMMIT");
      } catch (error) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
      return undefined;
    }],
    ["v2_write", each(scenario.v2_writes, V2.write, (r) => [r.id, r.account_id, r.amount_minor, r.currency, r.currency_exponent])],
    ["v2_read", async (c) => (await c.query(V2.read)).rows],
    ["v1_post_write", each(scenario.v1_post_writes, V1.write, v1Args)],
    ["v1_post_read", async (c) => (await c.query(V1.read)).rows],
  ];
}

/** Runs one rehearsal. Records what happened; never judges compatibility itself. */
export async function rehearse(scenario: Scenario, options: RehearsalOptions = {}): Promise<{ execution: Execution; containerRemoved: boolean | null }> {
  const now = options.now ?? (() => new Date());
  const start = options.startDatabase ?? startEphemeralPostgres;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const statementTimeoutMs = options.statementTimeoutMs ?? 10_000;
  const started_at = now().toISOString();
  const steps: StepOutcome[] = [];
  let abort: AbortReason | null = null;
  let postgres_version: string | null = null;
  let finished = false;
  let db: Database | null = null;
  let client: pg.Client | null = null;
  let starting: Promise<Database> | null = null;

  const work = async () => {
    try {
      starting = start();
      db = await starting;
    } catch {
      abort = "CONTAINER_START_FAILED";
      return;
    }
    if (finished) return;
    client = new pg.Client({ connectionString: db.connectionUri, statement_timeout: statementTimeoutMs, connectionTimeoutMillis: 10_000 });
    client.on("error", () => undefined); // surfaced through the failing query instead
    try {
      await client.connect();
      postgres_version = String((await client.query("SHOW server_version")).rows[0]?.server_version ?? "") || null;
    } catch {
      abort = "DATABASE_UNAVAILABLE";
      return;
    }
    for (const [id, run] of plan(scenario)) {
      if (finished) return;
      let outcome: StepOutcome;
      try {
        outcome = { id, ok: true, rows: await run(client) };
      } catch (error) {
        outcome = { id, ok: false, sqlstate: sqlstateOf(error), message: redact(String((error as Error)?.message ?? error)) };
      }
      if (finished) return;
      steps.push(outcome);
      if (!outcome.ok && isInfraFailure(outcome.sqlstate)) {
        abort = outcome.sqlstate === "57014" ? "TIMEOUT" : "DATABASE_UNAVAILABLE";
        return;
      }
    }
  };

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work().catch(() => { abort ??= "RUNNER_ERROR"; }),
      new Promise<void>((resolve) => { timer = setTimeout(() => { abort ??= "TIMEOUT"; resolve(); }, timeoutMs); }),
    ]);
  } finally {
    finished = true;
    clearTimeout(timer);
  }

  const snapshot = [...steps];
  const execution: Execution = { status: abort ? "ABORTED" : "COMPLETED", abort_reason: abort, steps: snapshot, postgres_version, started_at, completed_at: now().toISOString() };

  let containerRemoved: boolean | null = null;
  await (client as pg.Client | null)?.end().catch(() => undefined);
  const database = db as Database | null;
  if (database) {
    containerRemoved = await database.stop().catch(() => false);
  } else if (starting) {
    // Start outlived the timeout: stop it whenever it arrives; Ryuk reaps it if this process exits first.
    (starting as Promise<Database>).then((late) => late.stop()).catch(() => undefined);
  }
  return { execution, containerRemoved };
}

export function buildReport(scenario: Scenario, execution: Execution, containerRemoved: boolean | null): VerificationReport {
  const evaluation = evaluate(scenario, execution);
  return VerificationReportSchema.parse({
    schema_version: 1,
    scenario_id: scenario.id,
    scenario_version: scenario.version,
    fixture_digest: fixtureDigest(scenario),
    source: { kind: "local_fixture", commit_sha: null },
    postgres_image: POSTGRES_IMAGE,
    postgres_version: execution.postgres_version,
    runner_version: RUNNER_VERSION,
    started_at: execution.started_at,
    completed_at: execution.completed_at,
    execution_status: execution.status,
    ...evaluation,
    expectation: { expected_result: scenario.expected, met: evaluation.result === scenario.expected },
    cleanup: { container_removed: containerRemoved },
  });
}

/** Public entry point: only allowlisted scenarios may run. */
export async function runAllowlistedScenario(scenarioId: string, options?: RehearsalOptions): Promise<VerificationReport> {
  const scenario = SCENARIOS[scenarioId];
  if (!scenario) throw new Error(`scenario is not allowlisted: ${scenarioId}`);
  const { execution, containerRemoved } = await rehearse(scenario, options);
  return buildReport(scenario, execution, containerRemoved);
}
