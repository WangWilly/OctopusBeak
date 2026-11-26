import { DOMAIN_COUNTS_MARKER, RECORDS_MARKER } from "./compaction.ts";
import { planLedgerCompaction, type CompactionPlanResult } from "./compaction-plan.ts";
import type { LedgerBackupRoom } from "./data-dir-backup.ts";
import {
  estimateLedgerReclaim,
  LEDGER_RECLAIM_MIN_BYTES,
  LEDGER_RECLAIM_MIN_SHARE,
  reclaimFreeBytesNeeded,
  worthRewriting,
  type LedgerReclaimEstimate,
} from "./reclaim.ts";
import type { PGliteStore } from "./transaction.ts";

/**
 * The one estimate Settings shows before an App Data Cleanup (ADR 0156): the
 * compaction's dry run and the reclaim's estimate, read when the owner asks,
 * and the free space the run needs before it deletes anything.
 */
export type LedgerCleanupEstimate = Readonly<{
  /**
   * `planned`: the run compacts first. `compacted`: the markers are written,
   * so the run only reclaims and no dry run was read. `cannot`: a column cites
   * a record in a way the planner does not know, so the run only reclaims.
   */
  compaction: "planned" | "compacted" | "cannot";
  /** About what the compaction removes: the redundant sync data. */
  redundantBytes: number;
  /** About what the reclaim returns as the tables stand now: the temporary app data. */
  temporaryBytes: number;
  /**
   * Free space the run needs without a backup: three new copies of the
   * largest table the reclaim would rewrite after the compaction, as its live
   * bytes less the bytes the dry run would remove, plus the headroom. 0 when
   * no table would be rewritten.
   */
  reclaimNeededBytes: number;
  /**
   * The folder's size and what the run needs free with a backup: the
   * backup's own need plus `reclaimNeededBytes` (`cleanupBackupBytesNeeded`).
   * `unreadable` when the folder's size or the free space could not be read;
   * null when the ledger has no folder of its own.
   */
  backup: LedgerBackupRoom | "unreadable" | null;
  /** Free space on the ledger's disk; null when it could not be read. */
  freeBytes: number | null;
}>;

export type LedgerCleanupThresholds = Readonly<{ minBytes?: number; minShare?: number }>;

/** About what the run needs free after the compaction, without a backup. */
export function cleanupReclaimBytesNeeded(
  plan: CompactionPlanResult | null,
  reclaim: LedgerReclaimEstimate,
  { minBytes = LEDGER_RECLAIM_MIN_BYTES, minShare = LEDGER_RECLAIM_MIN_SHARE }: LedgerCleanupThresholds = {},
): number {
  const removedBytes = new Map<string, number>();
  if (plan?.status === "planned") {
    for (const { table, estimatedBytes } of [...plan.phaseA, ...plan.phaseB.tables, plan.phaseC]) {
      const name = `public.${table}`;
      removedBytes.set(name, (removedBytes.get(name) ?? 0) + estimatedBytes);
    }
  }
  // A compacted table holds the removed rows as dead space afterwards, so the reclaim may pick it then.
  let largest: number | null = null;
  for (const { table, bytes, compactBytes } of reclaim.measured) {
    const after = Math.max(0, compactBytes - (removedBytes.get(table) ?? 0));
    if (worthRewriting(bytes, bytes - after, minBytes, minShare)) largest = Math.max(largest ?? 0, after);
  }
  return reclaimFreeBytesNeeded(largest);
}

/**
 * Combines the dry run, the reclaim estimate and the backup room. The
 * estimate is read before the compaction, which only removes as much as the
 * dry run says or more, so the need is not understated by the compaction.
 */
export function combineLedgerCleanupEstimate(
  plan: CompactionPlanResult | null,
  reclaim: LedgerReclaimEstimate,
  backup: LedgerCleanupEstimate["backup"],
  thresholds: LedgerCleanupThresholds = {},
): LedgerCleanupEstimate {
  return {
    compaction: plan === null ? "compacted" : plan.status === "planned" ? "planned" : "cannot",
    redundantBytes: plan?.status === "planned" ? plan.estimatedBytes : 0,
    temporaryBytes: reclaim.reclaimableBytes,
    reclaimNeededBytes: cleanupReclaimBytesNeeded(plan, reclaim, thresholds),
    backup,
    freeBytes: backup !== null && backup !== "unreadable" ? backup.freeBytes : reclaim.freeBytes,
  };
}

export type LedgerCleanupEstimateOptions = Readonly<{
  /** Queues one step on the worker's background lane; by default a step runs at once. */
  runStep?: <T>(step: () => Promise<T>) => Promise<T>;
  signal?: AbortSignal;
  freeBytes?: () => Promise<number>;
  /** Reads the folder's size and the disk's free space, with what the run needs after the backup; absent when the ledger has no folder of its own. */
  backupRoom?: (reserveBytes: number) => Promise<LedgerBackupRoom>;
}> & LedgerCleanupThresholds;

/**
 * Reads the cleanup's estimate, one step at a time. The dry run holds the
 * ledger for seconds per large source, so it runs only when the owner asks,
 * and not at all once the compaction's markers are written.
 */
export async function estimateLedgerCleanup(store: PGliteStore, options: LedgerCleanupEstimateOptions = {}): Promise<LedgerCleanupEstimate> {
  const runStep = options.runStep ?? (<T>(step: () => Promise<T>) => step());
  const { rows } = await runStep(() => store.query<{ migration_key: string }>(
    "SELECT migration_key FROM pglite_operational_migrations WHERE migration_key = ANY($1::text[])",
    [[DOMAIN_COUNTS_MARKER, RECORDS_MARKER]],
  ));
  const plan = rows.length === 2 ? null : await planLedgerCompaction(store, { runStep, signal: options.signal });
  const reclaim = await estimateLedgerReclaim(store, {
    runStep,
    signal: options.signal,
    freeBytes: options.freeBytes,
    minBytes: options.minBytes,
    minShare: options.minShare,
  });
  const reserveBytes = cleanupReclaimBytesNeeded(plan, reclaim, options);
  const backup = options.backupRoom ? await options.backupRoom(reserveBytes).catch(() => "unreadable" as const) : null;
  return combineLedgerCleanupEstimate(plan, reclaim, backup, options);
}
