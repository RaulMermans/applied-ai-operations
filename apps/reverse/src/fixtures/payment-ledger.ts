/**
 * Synthetic payment-ledger fixtures for the RollbackProof spike. No real
 * financial data. Every SQL string here is trusted, in-repo, and reviewed;
 * the runner only executes scenarios from the allowlisted registry below.
 */

export type Row = { id: number; account_id: string; amount_cents: number; currency: string };

export type Scenario = {
  id: string;
  version: number;
  /** What a correct verifier must conclude. Used only to label the report, never by the evaluator. */
  expected: "PASS" | "FAIL";
  schema_v1: string[];
  seed_v1: Row[];
  migration: string[];
  v2_writes: { id: number; account_id: string; amount_minor: number; currency: string; currency_exponent: number }[];
  v1_post_writes: Row[];
};

/** Application v1 contract: the exact statements v1 runs. */
export const V1 = {
  read: "SELECT id, account_id, amount_cents, currency FROM ledger_entries ORDER BY id",
  write: "INSERT INTO ledger_entries (id, account_id, amount_cents, currency) VALUES ($1, $2, $3, $4)",
} as const;

/** Application v2 contract: v2 stores amounts as minor units with an explicit exponent. */
export const V2 = {
  write: "INSERT INTO ledger_entries (id, account_id, amount_minor, currency, currency_exponent) VALUES ($1, $2, $3, $4, $5)",
  read: "SELECT id, amount_minor, currency_exponent FROM ledger_entries ORDER BY id",
} as const;

const SCHEMA_V1 = [
  `CREATE TABLE ledger_entries (
     id BIGINT PRIMARY KEY,
     account_id TEXT NOT NULL,
     amount_cents BIGINT NOT NULL,
     currency CHAR(3) NOT NULL
   )`,
];

const SEED_V1: Row[] = [
  { id: 1, account_id: "acct-synthetic-a", amount_cents: 125_00, currency: "EUR" },
  { id: 2, account_id: "acct-synthetic-b", amount_cents: -40_50, currency: "EUR" },
  { id: 3, account_id: "acct-synthetic-a", amount_cents: 9_99, currency: "EUR" },
];

const V2_WRITES: Scenario["v2_writes"] = [
  { id: 4, account_id: "acct-synthetic-c", amount_minor: 310_00, currency: "EUR", currency_exponent: 2 },
  { id: 5, account_id: "acct-synthetic-b", amount_minor: -15_25, currency: "EUR", currency_exponent: 2 },
];

const V1_POST_WRITES: Row[] = [{ id: 6, account_id: "acct-synthetic-d", amount_cents: 7_00, currency: "EUR" }];

/** Scenario A: rename drops the column v1 reads and writes. Migration itself succeeds. */
export const INCOMPATIBLE_RENAME: Scenario = {
  id: "ledger-amount-rename-incompatible",
  version: 1,
  expected: "FAIL",
  schema_v1: SCHEMA_V1,
  seed_v1: SEED_V1,
  migration: [
    "ALTER TABLE ledger_entries RENAME COLUMN amount_cents TO amount_minor",
    "ALTER TABLE ledger_entries ADD COLUMN currency_exponent SMALLINT NOT NULL DEFAULT 2",
  ],
  v2_writes: V2_WRITES,
  v1_post_writes: V1_POST_WRITES,
};

/** Scenario B: expand step of expand-and-contract. Keeps amount_cents; a trigger keeps both columns in sync. */
export const COMPATIBLE_EXPAND: Scenario = {
  id: "ledger-amount-expand-compatible",
  version: 1,
  expected: "PASS",
  schema_v1: SCHEMA_V1,
  seed_v1: SEED_V1,
  migration: [
    "ALTER TABLE ledger_entries ADD COLUMN amount_minor BIGINT",
    "ALTER TABLE ledger_entries ADD COLUMN currency_exponent SMALLINT NOT NULL DEFAULT 2",
    "UPDATE ledger_entries SET amount_minor = amount_cents",
    `CREATE FUNCTION ledger_entries_sync_amount() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF NEW.amount_minor IS NULL THEN NEW.amount_minor := NEW.amount_cents; END IF;
       IF NEW.amount_cents IS NULL THEN
         IF NEW.currency_exponent <> 2 THEN RAISE EXCEPTION 'amount_cents requires currency_exponent = 2'; END IF;
         NEW.amount_cents := NEW.amount_minor;
       END IF;
       RETURN NEW;
     END $$`,
    // BEFORE triggers run before NOT NULL checks, so v2 inserts without amount_cents are filled in.
    `CREATE TRIGGER ledger_entries_sync_amount BEFORE INSERT OR UPDATE ON ledger_entries
     FOR EACH ROW EXECUTE FUNCTION ledger_entries_sync_amount()`,
    "ALTER TABLE ledger_entries ALTER COLUMN amount_minor SET NOT NULL",
  ],
  v2_writes: V2_WRITES,
  v1_post_writes: V1_POST_WRITES,
};

/** Explicit allowlist. The runner refuses anything not registered here. */
export const SCENARIOS: Readonly<Record<string, Scenario>> = Object.freeze({
  [INCOMPATIBLE_RENAME.id]: INCOMPATIBLE_RENAME,
  [COMPATIBLE_EXPAND.id]: COMPATIBLE_EXPAND,
});
