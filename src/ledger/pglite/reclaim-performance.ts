/**
 * What a ledger space reclaim (ADR 0155) does to a store bloated the way a
 * store written before ADR 0153 is, and whether the store still works after
 * it. It builds the store on disk, then:
 *
 * - re-syncs every fixture source, and rewrites each projection table's rows
 *   unchanged many times, as every commit's refresh did before ADR 0153;
 * - subscribes and unsubscribes live queries many times, each of which
 *   creates and drops a temporary view and its triggers in the catalog;
 * - runs the plain VACUUM the worker now runs, so the dead tuples are gone
 *   but the space they took stays in each table.
 *
 * It then estimates and runs the reclaim, timing each table, and reopens the
 * store to check every B-tree index (ADR 0147), a live query, a commit, and
 * that every table still holds the same rows.
 *
 *   npm run check:pglite-reclaim
 *
 * PGLITE_RECLAIM_ROWS (default 600) rows per source, PGLITE_RECLAIM_REWRITES
 * (default 60) projection rewrites, PGLITE_RECLAIM_TASK_RUNS (default 40)
 * sync runs and PGLITE_RECLAIM_LIVE_CYCLES (default 6000) live-query
 * subscriptions size the run. PGLITE_RECLAIM_LIVE_TABLE_MB (default 100)
 * sizes a separate table of live rows, whose rewrite shows how long one
 * large table holds the ledger and how much WAL it writes.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { PGlite } from "@electric-sql/pglite";
import { amcheck } from "@electric-sql/pglite/contrib/amcheck";
import { live, type PGliteWithLive } from "@electric-sql/pglite/live";
import { repairCorruptIndexes } from "./catalog-repair.ts";
import { directoryBytes, fsyncDirectory } from "./data-dir-files.ts";
import { createPgliteOperationalStore } from "./operational.ts";
import { estimateLedgerReclaim, reclaimLedgerSpace } from "./reclaim.ts";
import { commitResync, RESYNC_MODES } from "./resync-fixtures.ts";
import { installFinancialStore } from "./store-layout.ts";
import type { PGliteStore } from "./transaction.ts";
import { vacuumPgliteTable, pgliteTablesBySize } from "./vacuum.ts";
import { pgliteWalBacklogBytes } from "./wal-checkpoint.ts";

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

const ROWS = positiveInteger("PGLITE_RECLAIM_ROWS", 600);
const REWRITES = positiveInteger("PGLITE_RECLAIM_REWRITES", 60);
const LIVE_CYCLES = positiveInteger("PGLITE_RECLAIM_LIVE_CYCLES", 6000);
const TASK_RUNS = positiveInteger("PGLITE_RECLAIM_TASK_RUNS", 40);
const LIVE_TABLE_MB = positiveInteger("PGLITE_RECLAIM_LIVE_TABLE_MB", 100);

const PROJECTION_TABLES = [
  "current_transactions",
  "current_transaction_enrichment",
  "current_spending_pairing_entries",
  "projection_generation_transactions",
  "projection_generation_transaction_selection",
  "current_einvoice_item_categorizations",
] as const;

const MB = (bytes: number) => Math.round(bytes / 1024 / 1024 * 100) / 100;

async function open(dataDir: string): Promise<{ db: PGliteWithLive; store: PGliteStore }> {
  const db = await PGlite.create(dataDir, { extensions: { live, amcheck } }) as unknown as PGliteWithLive;
  return { db, store: await installFinancialStore(db as unknown as PGlite) };
}

/** Rewrites every row of `table` with the values it already holds, triggers off. */
async function rewriteUnchanged(store: PGliteStore, table: string): Promise<void> {
  const { rows } = await store.query<{ name: string }>(
    `SELECT column_name AS name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position LIMIT 1`,
    [table],
  );
  if (!rows[0]) return;
  await store.transaction(async (transaction) => {
    await transaction.query("SET LOCAL session_replication_role = replica");
    await transaction.query(`UPDATE ${table} SET ${rows[0]!.name} = ${rows[0]!.name}`);
  });
}

/**
 * Sync runs as the app records them: every stage event and progress update
 * rewrites the run's whole record, so a run leaves one dead copy of it, mostly
 * in TOAST, per event.
 */
async function recordTaskRuns(store: PGliteStore): Promise<void> {
  const operational = createPgliteOperationalStore(store);
  const codes = ["authentication-started", "collection-started", "month-completed", "statement-page-collected", "financial-commit-completed"];
  const stages = ["authentication", "collection", "decoding", "validation", "commit"] as const;
  let seed = 3;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const now = Date.UTC(2026, 10, 1);
  for (let run = 0; run < TASK_RUNS; run += 1) {
    let time = now - (TASK_RUNS - run) * 86_400_000;
    const events = 20 + Math.floor(random() * 150);
    const { taskRunId } = await operational.createTaskRun({
      taskId: `task-${run % 7}`, kind: "crawler", status: "running", attempt: 1, maxAttempts: 3, startedAt: new Date(time).toISOString(),
    } as never);
    for (let event = 0; event < events; event += 1) {
      time += Math.floor(random() * 4000);
      const stage = stages[Math.floor(random() * stages.length)]!;
      await operational.appendRunEvent({
        runId: taskRunId, stage, outcome: "advanced", code: codes[Math.floor(random() * codes.length)],
        occurredAt: new Date(time).toISOString(), completed: event, total: events,
      } as never);
      await operational.updateTaskRun(taskRunId, {
        progress: { phaseCode: `workflow-${stage}`, completed: event, total: events, percent: Math.round(event * 100 / events), attempt: 1 },
      } as never);
    }
    await operational.transitionTaskRunToTerminal(taskRunId, {
      status: "completed",
      finishedAt: new Date(time).toISOString(),
      appWorkflowOutcome: { errorCode: null, summary: { status: "completed", counts: { committedCount: 12 }, products: [] } },
    } as never);
  }
}

async function storeTables(store: PGliteStore): Promise<string[]> {
  const { rows } = await store.query<{ name: string }>(
    `SELECT format('%I.%I', schemaname, relname) AS name FROM pg_stat_user_tables ORDER BY 1`,
  );
  return rows.map(({ name }) => name);
}

/** Row count and a digest of every row, per store table. */
async function digests(store: PGliteStore): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const table of await storeTables(store)) {
    const { rows } = await store.query<{ count: number; digest: string | null }>(
      `SELECT count(*)::int AS count, md5(string_agg(t::text, E'\\n' ORDER BY t::text)) AS digest FROM ${table} t`,
    );
    result.set(table, `${rows[0]!.count}:${rows[0]!.digest ?? ""}`);
  }
  return result;
}

async function sizes(store: PGliteStore, schema: "pg_catalog" | "public") {
  const { rows } = await store.query<{ name: string; bytes: string }>(
    `SELECT c.relname AS name, pg_total_relation_size(c.oid)::text AS bytes
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r' AND NOT c.relisshared
      ORDER BY pg_total_relation_size(c.oid) DESC`,
    [schema],
  );
  return rows.map(({ name, bytes }) => ({ name, bytes: Number(bytes) }));
}

async function databaseBytes(store: PGliteStore): Promise<number> {
  const { rows } = await store.query<{ bytes: string }>("SELECT pg_database_size(current_database())::text AS bytes");
  return Number(rows[0]!.bytes);
}

async function walLsn(store: PGliteStore): Promise<string> {
  return (await store.query<{ lsn: string }>("SELECT pg_current_wal_insert_lsn()::text AS lsn")).rows[0]!.lsn;
}

async function walSince(store: PGliteStore, lsn: string): Promise<number> {
  return Number((await store.query<{ bytes: string }>(
    "SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), $1::pg_lsn)::text AS bytes", [lsn],
  )).rows[0]!.bytes);
}

const dataDir = await mkdtemp(join(tmpdir(), "octopus-beak-reclaim-"));
try {
  let { db, store } = await open(dataDir);
  const built = performance.now();
  for (const mode of RESYNC_MODES) {
    for (let sync = 1; sync <= 3; sync += 1) await commitResync(store, mode, sync, { rowCount: ROWS });
  }
  for (let round = 0; round < REWRITES; round += 1) {
    for (const table of PROJECTION_TABLES) await rewriteUnchanged(store, table);
  }
  await recordTaskRuns(store);
  const liveSql = "SELECT transaction_id FROM current_transactions ORDER BY transaction_id LIMIT 20";
  for (let cycle = 0; cycle < LIVE_CYCLES; cycle += 1) {
    const query = await db.live.query(liveSql, [], () => {});
    await query.unsubscribe();
  }
  // What the worker's vacuum leaves (ADR 0153): no dead tuples, the space kept.
  for (const table of await pgliteTablesBySize(store)) await vacuumPgliteTable(store, table);
  const buildSeconds = Math.round((performance.now() - built) / 100) / 10;

  const before = await digests(store);
  const catalogBefore = await sizes(store, "pg_catalog");
  const storeBefore = await sizes(store, "public");
  const databaseBefore = await databaseBytes(store);
  const free = async () => { const stats = await statfs(dataDir); return stats.bavail * stats.bsize; };

  let started = performance.now();
  const estimate = await estimateLedgerReclaim(store, { freeBytes: free });
  const estimateMs = Math.round(performance.now() - started);

  // Start from an empty WAL backlog, so its peak below is the reclaim's own.
  await store.exec("CHECKPOINT");
  const lsn = await walLsn(store);
  let walPeak = 0;
  const syncs: number[] = [];
  started = performance.now();
  const result = await reclaimLedgerSpace(store, {
    freeBytes: free,
    folderBytes: () => directoryBytes(dataDir),
    syncToDisk: async () => {
      const syncStarted = performance.now();
      await fsyncDirectory(dataDir);
      syncs.push(performance.now() - syncStarted);
    },
    runStep: async (step) => {
      const value = await step();
      walPeak = Math.max(walPeak, await pgliteWalBacklogBytes(store));
      return value;
    },
  });
  const reclaimMs = Math.round(performance.now() - started);
  const walBytes = await walSince(store, lsn);

  // One table that is mostly live rows: how long its rewrite holds the ledger, and how much WAL it writes.
  await store.exec(`CREATE TABLE reclaim_live_rows (id int PRIMARY KEY, pad text);
    INSERT INTO reclaim_live_rows SELECT g, repeat(md5(g::text || random()::text), 32) FROM generate_series(1, ${LIVE_TABLE_MB * 950}) g;`);
  await store.exec("CHECKPOINT");
  const liveTableBytes = Number((await store.query<{ bytes: string }>("SELECT pg_total_relation_size('reclaim_live_rows')::text AS bytes")).rows[0]!.bytes);
  const liveLsn = await walLsn(store);
  started = performance.now();
  await store.exec("VACUUM (FULL, ANALYZE) reclaim_live_rows");
  const liveRewriteMs = Math.round(performance.now() - started);
  const liveWalBytes = await walSince(store, liveLsn);
  await store.exec("DROP TABLE reclaim_live_rows");
  await store.exec("CHECKPOINT");
  const databaseAfter = await databaseBytes(store);
  const catalogAfter = new Map((await sizes(store, "pg_catalog")).map(({ name, bytes }) => [name, bytes]));
  const storeAfter = new Map((await sizes(store, "public")).map(({ name, bytes }) => [name, bytes]));
  await store.close();

  // Reopen as the worker does after an unclean close, and use the store.
  ({ db, store } = await open(dataDir));
  const indexCheck = await repairCorruptIndexes(db as unknown as PGlite);
  const after = await digests(store);
  const changedTables = [...before].filter(([table, digest]) => after.get(table) !== digest).map(([table]) => table);
  let liveFired = 0;
  const query = await db.live.query("SELECT count(*)::int AS count FROM current_transactions", [], () => { liveFired += 1; });
  await commitResync(store, "deposit", 4, { rowCount: ROWS });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await query.unsubscribe();
  await store.close();

  const report = {
    rows: ROWS,
    rewrites: REWRITES,
    taskRuns: TASK_RUNS,
    liveCycles: LIVE_CYCLES,
    buildSeconds,
    databaseMB: { before: MB(databaseBefore), after: MB(databaseAfter) },
    estimate: {
      ms: estimateMs,
      tables: estimate.tables.length,
      reclaimableMB: MB(estimate.reclaimableBytes),
      requiredFreeMB: MB(estimate.requiredFreeBytes),
    },
    reclaim: result.status === "reclaimed" || result.status === "stopped" || result.status === "failed"
      ? {
        status: result.status,
        ms: reclaimMs,
        walMB: MB(walBytes),
        walPeakMB: MB(walPeak),
        tablesReclaimedMB: MB(result.bytesBefore - result.bytesAfter),
        folderMB: { before: MB(result.folderBytesBefore ?? 0), after: MB(result.folderBytesAfter ?? 0) },
        fsyncMs: syncs.map(Math.round),
        longestLockMs: Math.round(result.longestMilliseconds),
        tables: result.tables.map(({ table, bytesBefore, bytesAfter, milliseconds }) =>
          `${table}: ${MB(bytesBefore)} -> ${MB(bytesAfter)} MB in ${Math.round(milliseconds)} ms`),
      }
      : result,
    liveTable: {
      mb: MB(liveTableBytes),
      rewriteMs: liveRewriteMs,
      walMB: MB(liveWalBytes),
      walPerCopy: Math.round(liveWalBytes / liveTableBytes * 100) / 100,
    },
    catalogMB: catalogBefore.slice(0, 8).map(({ name, bytes }) => `${name}: ${MB(bytes)} -> ${MB(catalogAfter.get(name) ?? 0)}`),
    storeMB: storeBefore.slice(0, 10).map(({ name, bytes }) => `${name}: ${MB(bytes)} -> ${MB(storeAfter.get(name) ?? 0)}`),
    afterReopen: {
      indexCheck: indexCheck.status,
      tablesWithChangedRows: changedTables,
      liveQueryNotified: liveFired > 0,
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (indexCheck.status !== "intact" || changedTables.length > 0 || liveFired === 0 || result.status !== "reclaimed") {
    process.exitCode = 1;
  }
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
