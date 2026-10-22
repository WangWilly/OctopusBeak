import type { PGliteStore } from "./transaction.ts";

/**
 * PGlite runs Postgres as a single backend with no checkpointer process, so
 * `checkpoint_timeout` never fires and the WAL since the last checkpoint grows
 * until `max_wal_size` (1 GB). A launch after an unclean exit replays all of
 * it before the ledger answers a query. Checkpointing past this backlog keeps
 * that replay to seconds.
 */
export const PGLITE_WAL_CHECKPOINT_THRESHOLD_BYTES = 64 * 1024 * 1024;
export const PGLITE_WAL_CHECKPOINT_INTERVAL_MS = 60_000;

/** WAL a crash recovery would replay: from the last checkpoint's redo point. */
export async function pgliteWalBacklogBytes(store: PGliteStore): Promise<number> {
  const result = await store.query<{ bytes: number | string }>(
    "SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), redo_lsn) AS bytes FROM pg_control_checkpoint()",
  );
  return Number(result.rows[0]?.bytes ?? 0);
}

export async function checkpointPgliteWalBacklog(
  store: PGliteStore,
  thresholdBytes: number,
): Promise<boolean> {
  if (await pgliteWalBacklogBytes(store) <= thresholdBytes) return false;
  await store.exec("CHECKPOINT");
  return true;
}

export type PgliteWalCheckpoints = {
  /** Resolves once no checkpoint is running and none will start. */
  stop(): Promise<void>;
};

export function startPgliteWalCheckpoints(
  store: PGliteStore,
  options: {
    intervalMs?: number;
    thresholdBytes?: number;
    onCheckpoint?: () => void;
    onError?: (error: unknown) => void;
  } = {},
): PgliteWalCheckpoints {
  const intervalMs = options.intervalMs ?? PGLITE_WAL_CHECKPOINT_INTERVAL_MS;
  const thresholdBytes = options.thresholdBytes ?? PGLITE_WAL_CHECKPOINT_THRESHOLD_BYTES;
  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    timer = setTimeout(() => {
      running = checkpointPgliteWalBacklog(store, thresholdBytes)
        .then((checkpointed) => { if (checkpointed) options.onCheckpoint?.(); })
        .catch((error: unknown) => { if (!stopped) options.onError?.(error); })
        .finally(() => { if (!stopped) schedule(); });
    }, intervalMs);
    // A pending checkpoint must never keep the worker alive on its own.
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
