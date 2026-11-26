import type {
  LedgerCleanupEstimateDto,
  LedgerCleanupProgressDto,
  LedgerCleanupResultDto,
  LedgerCleanupStatusDto,
} from "../desktop/api.ts";

/** Whether the run can take a Cleanup Backup first (ADR 0156). */
export type CleanupBackupChoice =
  /** The disk has room for the run and the backup; the box is offered, ticked. `bytes` is the ledger folder's size. */
  | Readonly<{ kind: "fits"; bytes: number }>
  /** The disk has room for the run but not the backup: the box is disabled and unticked. */
  | Readonly<{ kind: "no-room"; neededBytes: number }>
  /** The ledger has no folder of its own to copy. */
  | Readonly<{ kind: "unavailable" }>;

/** What the Clean up app data row shows. */
export type LedgerCleanupView =
  | Readonly<{ kind: "idle" | "checking" | "nothing" | "backup-failed" }>
  /** Not enough free space for the run: it does not start. */
  | Readonly<{ kind: "no-room"; neededBytes: number; freeBytes: number }>
  | Readonly<{ kind: "estimated"; redundantBytes: number; temporaryBytes: number; backup: CleanupBackupChoice }>
  | Readonly<{ kind: "running"; progress: LedgerCleanupProgressDto | null }>
  | Readonly<{ kind: "done" | "stopped" | "failed"; freedBytes: number }>
  /** The redundant data is removed, but the disk ran out of room before the space returned. */
  | Readonly<{ kind: "out-of-room"; freedBytes: number; remainingBytes: number; neededBytes: number }>;

export type LedgerCleanupBridge = Readonly<{
  cleanUpLedger(request: Readonly<{ backup: boolean; keepBackup: boolean }>): Promise<LedgerCleanupResultDto>;
  ledgerCleanupStatus(): Promise<LedgerCleanupStatusDto>;
}>;

/** Megabytes for the copy: whole numbers from 10 MB, one decimal below. */
export function megabytes(bytes: number): string {
  const value = bytes / (1024 * 1024);
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}

/**
 * The estimate as the row shows it. The run needs the reclaim's room; with a
 * backup it needs the larger of that and the backup's (ADR 0156).
 */
export function cleanupEstimateView(estimate: LedgerCleanupEstimateDto): LedgerCleanupView {
  if (estimate.redundantBytes + estimate.temporaryBytes === 0) return { kind: "nothing" };
  const free = estimate.freeBytes;
  if (free !== null && free < estimate.neededBytes) return { kind: "no-room", neededBytes: estimate.neededBytes, freeBytes: free };
  let backup: CleanupBackupChoice = { kind: "unavailable" };
  if (estimate.backup !== null) {
    const neededBytes = Math.max(estimate.neededBytes, estimate.backup.neededBytes);
    backup = free !== null && free >= neededBytes ? { kind: "fits", bytes: estimate.backup.bytes } : { kind: "no-room", neededBytes };
  }
  return { kind: "estimated", redundantBytes: estimate.redundantBytes, temporaryBytes: estimate.temporaryBytes, backup };
}

export function cleanupResultView(result: LedgerCleanupResultDto): LedgerCleanupView {
  switch (result.status) {
    case "already-running": return { kind: "running", progress: null };
    case "done":
    case "stopped":
    case "failed":
      return { kind: result.status, freedBytes: result.freedBytes };
    case "backup-failed": return { kind: "backup-failed" };
    case "no-room":
      return { kind: "out-of-room", freedBytes: result.freedBytes, remainingBytes: result.remainingBytes, neededBytes: result.neededBytes };
  }
}

/** One part of the progress bar: `fill` from 0 to 1, or null while its length is unknown. */
export type CleanupProgressSegment = Readonly<{ part: "backup" | "compaction" | "reclaim"; fill: number | null }>;

/**
 * The bar's three parts: the backup, with no known length; the compaction,
 * step `index` of `count`; the reclaim, table `index` of `count`. A part the
 * run skipped is full once a later one runs. `percent` is null while the
 * backup runs or before the first report.
 */
export function cleanupProgressBar(progress: LedgerCleanupProgressDto | null): Readonly<{
  segments: readonly CleanupProgressSegment[];
  percent: number | null;
}> {
  const share = (index: number, count: number) => (count > 0 ? Math.min(1, Math.max(0, (index - 1) / count)) : 0);
  const fills: [number | null, number, number] =
    progress === null ? [0, 0, 0]
    : progress.phase === "backing-up" ? [null, 0, 0]
    : progress.phase === "compacting" ? [1, share(progress.index, progress.count), 0]
    : [1, 1, share(progress.index, progress.count)];
  const [backup, compaction, reclaim] = fills;
  return {
    segments: [{ part: "backup", fill: backup }, { part: "compaction", fill: compaction }, { part: "reclaim", fill: reclaim }],
    percent: progress === null || backup === null ? null : Math.round(((backup + compaction + reclaim) / 3) * 100),
  };
}

const FAILED: LedgerCleanupView = { kind: "failed", freedBytes: 0 };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Follows a cleanup already running in the worker until it ends, then shows how it ended. A failed read is retried. */
async function follow(
  bridge: LedgerCleanupBridge,
  show: (view: LedgerCleanupView) => void,
  pollMs: number,
  signal: AbortSignal | undefined,
): Promise<LedgerCleanupView> {
  let view: LedgerCleanupView = { kind: "running", progress: null };
  while (!signal?.aborted) {
    let status: LedgerCleanupStatusDto | undefined;
    try {
      status = await bridge.ledgerCleanupStatus();
    } catch {
      // The next read tries again.
    }
    if (status && !status.running) {
      view = status.last ? cleanupResultView(status.last) : { kind: "idle" };
      show(view);
      return view;
    }
    if (status?.running) show(view = { kind: "running", progress: status.progress });
    await wait(pollMs);
  }
  return view;
}

/**
 * When Settings opens: follows a cleanup still running in the worker until
 * it ends, so its dialog shows again, or shows the last run's failure, which
 * the worker reads back from the ledger after a restart. Otherwise shows
 * nothing new.
 */
export async function resumeLedgerCleanup(
  bridge: LedgerCleanupBridge,
  show: (view: LedgerCleanupView) => void,
  { pollMs = 1000, signal }: Readonly<{ pollMs?: number; signal?: AbortSignal }> = {},
): Promise<void> {
  let status: LedgerCleanupStatusDto;
  try {
    status = await bridge.ledgerCleanupStatus();
  } catch {
    return;
  }
  if (!status.running) {
    if (status.last?.status === "failed" || status.last?.status === "backup-failed") show(cleanupResultView(status.last));
    return;
  }
  await follow(bridge, show, pollMs, signal);
}

/**
 * Runs the cleanup and reports its progress every `pollMs` until it ends.
 * When one is already running, follows that one instead.
 */
export async function runLedgerCleanup(
  bridge: LedgerCleanupBridge,
  request: Readonly<{ backup: boolean; keepBackup: boolean }>,
  show: (view: LedgerCleanupView) => void,
  { pollMs = 1000, signal }: Readonly<{ pollMs?: number; signal?: AbortSignal }> = {},
): Promise<LedgerCleanupView> {
  show({ kind: "running", progress: null });
  let ended = false;
  const timer = setInterval(() => {
    void bridge.ledgerCleanupStatus().then(
      (status) => { if (!ended && status.running) show({ kind: "running", progress: status.progress }); },
      () => {},
    );
  }, pollMs);
  let result: LedgerCleanupResultDto | undefined;
  try {
    result = await bridge.cleanUpLedger(request);
  } catch {
    // Shown as failed below.
  } finally {
    ended = true;
    clearInterval(timer);
  }
  if (result?.status === "already-running") return follow(bridge, show, pollMs, signal);
  const view = result ? cleanupResultView(result) : FAILED;
  show(view);
  return view;
}
