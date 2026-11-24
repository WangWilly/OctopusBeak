/**
 * How much the canonical store grows when a source is synced again with
 * nothing new (ADR 0152). It commits the same records repeatedly, each time
 * under a new capture id and a window that starts and ends a day later, as a
 * collection window does, so the oldest rows age out. It fails when any table
 * gains rows in proportion to the records re-sighted rather than a fixed
 * number per capture.
 *
 *   npm run check:pglite-resync-growth
 *
 * PGLITE_RESYNC_RECORDS (default 200) and PGLITE_RESYNC_SYNCS (default 10)
 * size the run; PGLITE_RESYNC_MODE is one of the modes below or `all`.
 * `deposit` and `card-route` go through the generic commit; `card-route` uses
 * a credit-card route and bucket coverage, one bucket per day so a day leaves
 * the inventory with the window. `card-command` drives the credit-card
 * command on the same records, with an instrument, statements and each
 * purchase's card details and lifecycle, so it also measures the command's
 * own rows. `einvoice`, `investment` and `loan` drive those domain commands
 * on records in the same moving window: invoices; investment transactions
 * with named securities and two holdings; loan payments with three
 * repayment deposits linked to them.
 */
import { performance } from "node:perf_hooks";
import { PGlite } from "@electric-sql/pglite";
import { commitResync, RESYNC_MODES, type ResyncMode } from "./resync-fixtures.ts";
import { installFinancialStore } from "./store-layout.ts";
import type { PGliteStore } from "./transaction.ts";

function positiveInteger(name: string, fallback: number, minimum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer of at least ${minimum}.`);
  return value;
}

const RECORDS = positiveInteger("PGLITE_RESYNC_RECORDS", 200, 20);
const SYNCS = positiveInteger("PGLITE_RESYNC_SYNCS", 10, 2);
const MODES: readonly ResyncMode[] = (() => {
  const mode = process.env.PGLITE_RESYNC_MODE ?? "all";
  if (mode === "all") return RESYNC_MODES;
  const chosen = RESYNC_MODES.find((candidate) => candidate === mode);
  if (chosen === undefined) throw new Error(`PGLITE_RESYNC_MODE must be ${RESYNC_MODES.join(", ")} or all.`);
  return [chosen];
})();

/**
 * Rows a table may gain per unchanged re-sync. A capture itself, its scope,
 * pages, coverage and a reuse manifest are a few rows each; anything more
 * grows with the records the sync saw again.
 */
const ROWS_PER_RESYNC_BUDGET = 8;

/**
 * Bytes an unchanged re-sync may add per record seen again: a reused record
 * costs about 16 bytes in its capture's manifest, and a capture's own rows
 * are spread over its records. Storing each record again cost about 3,900.
 */
const BYTES_PER_RECORD_BUDGET = 256;

async function rowCounts(store: PGliteStore): Promise<Map<string, number>> {
  const tables = await store.query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
  );
  const counts = new Map<string, number>();
  for (const { name } of tables.rows) {
    const { rows: [row] } = await store.query<{ count: number }>(`SELECT count(*)::int AS count FROM "${name}"`);
    counts.set(name, row!.count);
  }
  return counts;
}

async function databaseBytes(store: PGliteStore): Promise<number> {
  const { rows: [row] } = await store.query<{ bytes: string }>("SELECT pg_database_size(current_database())::text AS bytes");
  return Number(row!.bytes);
}

type Growth = Readonly<{ table: string; perResync: number }>;

async function deadTuples(store: PGliteStore): Promise<number> {
  const { rows: [row] } = await store.query<{ dead: string }>(
    "SELECT COALESCE(SUM(n_dead_tup), 0)::text AS dead FROM pg_stat_user_tables",
  );
  return Number(row!.dead);
}

async function measure(mode: ResyncMode) {
  const store = await installFinancialStore(await PGlite.create());
  try {
    await commitResync(store, mode, 1, { rowCount: RECORDS });
    const afterFirst = await rowCounts(store);
    const bytesAfterFirst = await databaseBytes(store);
    const deadAfterFirst = await deadTuples(store);
    const started = performance.now();
    for (let sync = 2; sync <= SYNCS; sync += 1) {
      await commitResync(store, mode, sync, { rowCount: RECORDS });
    }
    const resyncMs = (performance.now() - started) / (SYNCS - 1);
    const afterLast = await rowCounts(store);
    const bytesPerResync = (await databaseBytes(store) - bytesAfterFirst) / (SYNCS - 1);
    const deadTuplesPerResync = (await deadTuples(store) - deadAfterFirst) / (SYNCS - 1);
    const growth: Growth[] = [...afterLast]
      .map(([table, count]) => ({ table, perResync: (count - (afterFirst.get(table) ?? 0)) / (SYNCS - 1) }))
      .filter(({ perResync }) => perResync > 0)
      .sort((a, b) => b.perResync - a.perResync);
    return { mode, growth, bytesPerResync, deadTuplesPerResync, resyncMs };
  } finally {
    await store.close();
  }
}

let failed = false;
for (const mode of MODES) {
  const { growth, bytesPerResync, deadTuplesPerResync, resyncMs } = await measure(mode);
  const overBudget = growth.filter(({ perResync }) => perResync > ROWS_PER_RESYNC_BUDGET);
  const bytesPerRecord = bytesPerResync / RECORDS;
  console.log(JSON.stringify({
    mode,
    records: RECORDS,
    syncs: SYNCS,
    bytesPerResync: Math.round(bytesPerResync),
    bytesPerRecordPerResync: Math.round(bytesPerRecord),
    deadTuplesPerResync: Math.round(deadTuplesPerResync),
    commitMsPerResync: Math.round(resyncMs),
    rowsPerResync: Object.fromEntries(growth.map(({ table, perResync }) => [table, perResync])),
    overBudget: overBudget.map(({ table }) => table),
  }, null, 2));
  if (overBudget.length > 0 || bytesPerRecord > BYTES_PER_RECORD_BUDGET) failed = true;
}
if (failed) {
  console.error(
    `An unchanged re-sync grew a table by more than ${ROWS_PER_RESYNC_BUDGET} rows, `
      + `or the store by more than ${BYTES_PER_RECORD_BUDGET} bytes per record (ADR 0152).`,
  );
  process.exitCode = 1;
}
