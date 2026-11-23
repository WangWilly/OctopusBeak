import type { PGliteStore } from "./transaction.ts";

/**
 * PGlite runs Postgres as a single backend with no autovacuum launcher, so
 * the dead tuples an UPDATE or DELETE leaves are never reclaimed on their own
 * and a table that is rewritten keeps growing. This step stands in for
 * autovacuum (ADR 0153):
 *
 * - Shortly after the store opens, a VACUUM of every table, smallest first.
 *   PGlite keeps no table statistics across a close, so dead tuples left by
 *   an earlier session are invisible to the threshold below. The visibility
 *   map makes this pass cheap on a store that is already clean.
 * - Then, every interval, a VACUUM of each table whose dead tuples passed
 *   autovacuum's default threshold: 50 plus a fifth of its live rows. System
 *   catalogs count too; a live-view subscription creates and drops a
 *   temporary view, and every ANALYZE rewrites `pg_statistic`.
 *
 * A plain VACUUM frees dead tuples' space for the table's next writes. It
 * takes an exclusive lock only briefly, to cut empty pages from the end of a
 * table, so a table stays near its working size.
 */
export const PGLITE_VACUUM_THRESHOLD_TUPLES = 50;
export const PGLITE_VACUUM_SCALE_FACTOR = 0.2;
export const PGLITE_VACUUM_INTERVAL_MS = 60_000;
export const PGLITE_VACUUM_STARTUP_DELAY_MS = 5_000;

export type PgliteVacuumPolicy = Readonly<{ thresholdTuples?: number; scaleFactor?: number }>;

// A TOAST table is vacuumed with its owner, and a temporary one belongs to its session.
const VACUUMED_TABLES = `
  FROM pg_stat_all_tables
 WHERE schemaname <> 'pg_toast'
   AND schemaname NOT LIKE 'pg\\_temp\\_%'
   AND schemaname NOT LIKE 'pg\\_toast\\_temp\\_%'`;

/** The tables, catalogs included, whose dead tuples passed the threshold, most dead first. */
export async function pgliteTablesToVacuum(store: PGliteStore, policy: PgliteVacuumPolicy = {}): Promise<string[]> {
  // A backend publishes its table counts at most once a second, after a
  // statement ends; this makes the read below see every write before it.
  await store.query("SELECT pg_stat_force_next_flush()");
  const result = await store.query<{ table_name: string }>(
    `SELECT format('%I.%I', schemaname, relname) AS table_name
       ${VACUUMED_TABLES}
        AND n_dead_tup > $1::float8 + $2::float8 * n_live_tup
      ORDER BY n_dead_tup DESC`,
    [policy.thresholdTuples ?? PGLITE_VACUUM_THRESHOLD_TUPLES, policy.scaleFactor ?? PGLITE_VACUUM_SCALE_FACTOR],
  );
  return result.rows.map((row) => row.table_name);
}

/** Every table, catalogs included, smallest first. */
export async function pgliteTablesBySize(store: PGliteStore): Promise<string[]> {
  const result = await store.query<{ table_name: string }>(
    `SELECT format('%I.%I', schemaname, relname) AS table_name
       ${VACUUMED_TABLES}
      ORDER BY pg_total_relation_size(relid), schemaname, relname`,
  );
  return result.rows.map((row) => row.table_name);
}

/**
 * Vacuums one table. A store table is analyzed too: a plain VACUUM records the
 * table's current page count and keeps its old statistics, and
 * `refreshPlannerStatistics` reads that page count as the size the statistics
 * describe, so it would not analyze the table again until it grew another
 * tenth. A catalog is only vacuumed. VACUUM cannot run in a transaction block,
 * so this is its own statement.
 */
export async function vacuumPgliteTable(store: PGliteStore, table: string): Promise<void> {
  await store.exec(table.startsWith("pg_catalog.") ? `VACUUM ${table}` : `VACUUM (ANALYZE) ${table}`);
}

export type PgliteVacuumPass = Readonly<{
  vacuumed: readonly string[];
  failed: readonly Readonly<{ table: string; error: unknown }>[];
}>;

/** Vacuums the tables past the threshold. A table that fails is reported and the rest are still vacuumed. */
export async function vacuumPgliteDeadTuples(store: PGliteStore, policy: PgliteVacuumPolicy = {}): Promise<PgliteVacuumPass> {
  const vacuumed: string[] = [];
  const failed: { table: string; error: unknown }[] = [];
  for (const table of await pgliteTablesToVacuum(store, policy)) {
    try {
      await vacuumPgliteTable(store, table);
      vacuumed.push(table);
    } catch (error) {
      failed.push({ table, error });
    }
  }
  return { vacuumed, failed };
}

export type PgliteVacuums = {
  /** Resolves once no vacuum is running and none will start. */
  stop(): Promise<void>;
};

export function startPgliteVacuums(
  store: PGliteStore,
  options: PgliteVacuumPolicy & {
    intervalMs?: number;
    /** Delay before the pass over every table, so a launch reads its pages first. */
    startupDelayMs?: number;
    /** Queue that owns the database; a VACUUM blocks its thread while it runs. */
    run?: <T>(task: () => Promise<T>) => Promise<T>;
    onVacuum?: (tables: readonly string[]) => void;
    onError?: (error: unknown, table?: string) => void;
  } = {},
): PgliteVacuums {
  const intervalMs = options.intervalMs ?? PGLITE_VACUUM_INTERVAL_MS;
  const run = options.run ?? (<T>(task: () => Promise<T>) => task());
  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Each table is its own task on the queue, so work queued meanwhile runs
  // between two tables instead of waiting for the whole store.
  const startupPass = async () => {
    for (const table of await run(() => pgliteTablesBySize(store))) {
      if (stopped) return;
      try {
        await run(() => vacuumPgliteTable(store, table));
      } catch (error) {
        if (!stopped) options.onError?.(error, table);
      }
    }
  };
  const tick = async () => {
    const pass = await run(() => vacuumPgliteDeadTuples(store, options));
    if (stopped) return;
    if (pass.vacuumed.length > 0) options.onVacuum?.(pass.vacuumed);
    for (const { table, error } of pass.failed) options.onError?.(error, table);
  };
  const schedule = (delayMs: number, task: () => Promise<void>) => {
    timer = setTimeout(() => {
      running = task()
        .catch((error: unknown) => { if (!stopped) options.onError?.(error); })
        .finally(() => { if (!stopped) schedule(intervalMs, tick); });
    }, delayMs);
    // A pending vacuum must never keep the worker alive on its own.
    timer.unref?.();
  };
  schedule(options.startupDelayMs ?? PGLITE_VACUUM_STARTUP_DELAY_MS, startupPass);
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
