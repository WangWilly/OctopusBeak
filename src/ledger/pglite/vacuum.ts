import type { PGliteStore } from "./transaction.ts";

/**
 * PGlite runs Postgres as a single backend with no autovacuum launcher, so
 * the dead tuples an UPDATE or DELETE leaves are never reclaimed on their own
 * and a table that is rewritten keeps growing. This step does what autovacuum
 * would: it vacuums each table whose dead tuples passed autovacuum's default
 * threshold, 50 plus a fifth of its live rows. A plain VACUUM takes no
 * exclusive lock; it marks the space free for the table's next writes, so a
 * table stays at its working size instead of shrinking (ADR 0153).
 */
export const PGLITE_VACUUM_THRESHOLD_TUPLES = 50;
export const PGLITE_VACUUM_SCALE_FACTOR = 0.2;
export const PGLITE_VACUUM_INTERVAL_MS = 60_000;

export type PgliteVacuumPolicy = Readonly<{ thresholdTuples?: number; scaleFactor?: number }>;

/** The tables whose dead tuples passed the threshold, most dead first. */
export async function pgliteTablesToVacuum(store: PGliteStore, policy: PgliteVacuumPolicy = {}): Promise<string[]> {
  // A backend publishes its table counts at most once a second, after a
  // statement ends; this makes the read below see every write before it.
  await store.query("SELECT pg_stat_force_next_flush()");
  const result = await store.query<{ table_name: string }>(
    `SELECT format('%I.%I', schemaname, relname) AS table_name
       FROM pg_stat_user_tables
      WHERE n_dead_tup > $1::float8 + $2::float8 * n_live_tup
      ORDER BY n_dead_tup DESC`,
    [policy.thresholdTuples ?? PGLITE_VACUUM_THRESHOLD_TUPLES, policy.scaleFactor ?? PGLITE_VACUUM_SCALE_FACTOR],
  );
  return result.rows.map((row) => row.table_name);
}

/**
 * Vacuums the tables past the threshold and returns them. ANALYZE comes with
 * it: VACUUM records the table's current page count, which the projection
 * reads as the size its statistics describe (`refreshPlannerStatistics`).
 */
export async function vacuumPgliteDeadTuples(store: PGliteStore, policy: PgliteVacuumPolicy = {}): Promise<string[]> {
  const tables = await pgliteTablesToVacuum(store, policy);
  // VACUUM cannot run in a transaction block, so each table is its own statement.
  for (const table of tables) await store.exec(`VACUUM (ANALYZE) ${table}`);
  return tables;
}

export type PgliteVacuums = {
  /** Resolves once no vacuum is running and none will start. */
  stop(): Promise<void>;
};

export function startPgliteVacuums(
  store: PGliteStore,
  options: PgliteVacuumPolicy & {
    intervalMs?: number;
    /** Queue that owns the database; a VACUUM blocks its thread while it runs. */
    run?: <T>(task: () => Promise<T>) => Promise<T>;
    onVacuum?: (tables: readonly string[]) => void;
    onError?: (error: unknown) => void;
  } = {},
): PgliteVacuums {
  const intervalMs = options.intervalMs ?? PGLITE_VACUUM_INTERVAL_MS;
  const run = options.run ?? (<T>(task: () => Promise<T>) => task());
  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    timer = setTimeout(() => {
      running = run(() => vacuumPgliteDeadTuples(store, options))
        .then((tables) => { if (tables.length > 0) options.onVacuum?.(tables); })
        .catch((error: unknown) => { if (!stopped) options.onError?.(error); })
        .finally(() => { if (!stopped) schedule(); });
    }, intervalMs);
    // A pending vacuum must never keep the worker alive on its own.
    timer.unref?.();
  };
  schedule();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
