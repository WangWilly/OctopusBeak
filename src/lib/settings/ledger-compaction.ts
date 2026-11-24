import type {
  LedgerCompactionEstimateDto,
  LedgerCompactionProgressDto,
  LedgerCompactionResultDto,
  LedgerCompactionStatusDto,
} from "../desktop/api.ts";

/** What the Compact ledger row shows (ADR 0154). */
export type LedgerCompactionView =
  | Readonly<{ kind: "idle" | "checking" | "nothing" | "cannot" }>
  /** `backupOffered`: the disk has room for a copy of the ledger, so Settings offers one first. */
  | Readonly<{ kind: "estimated"; removableBytes: number; backupOffered: boolean }>
  | Readonly<{ kind: "running"; progress: LedgerCompactionProgressDto | null }>
  /** `reclaimedBytes` null: the rows are gone but their space is not returned yet. */
  | Readonly<{ kind: "done"; removedRows: number; reclaimedBytes: number | null }>
  | Readonly<{ kind: "stopped"; removedRows: number }>
  /** `backup`: the backup failed, so nothing was compacted. */
  | Readonly<{ kind: "failed"; removedRows: number; backup: boolean }>;

export type LedgerCompactionBridge = Readonly<{
  compactLedger(request: Readonly<{ backup: boolean }>): Promise<LedgerCompactionResultDto>;
  ledgerCompactionStatus(): Promise<LedgerCompactionStatusDto>;
}>;

/** Row counts for the copy, grouped by thousands in either language. */
export function rowCount(rows: number): string {
  return new Intl.NumberFormat("en-US").format(rows);
}

const FAILED: LedgerCompactionView = { kind: "failed", removedRows: 0, backup: false };

export function compactionEstimateView(estimate: LedgerCompactionEstimateDto): LedgerCompactionView {
  if (estimate.status === "cannot-compact") return { kind: "cannot" };
  if (estimate.removableRows === 0) return { kind: "nothing" };
  const backupOffered = estimate.storeBytes !== null && estimate.freeBytes !== null && estimate.freeBytes >= estimate.storeBytes;
  return { kind: "estimated", removableBytes: estimate.removableBytes, backupOffered };
}

export function compactionResultView(result: LedgerCompactionResultDto): LedgerCompactionView {
  switch (result.status) {
    case "already-compacted": return { kind: "nothing" };
    case "already-running": return { kind: "running", progress: null };
    case "compacted": return { kind: "done", removedRows: result.removedRows, reclaimedBytes: result.reclaimedBytes };
    case "stopped": return { kind: "stopped", removedRows: result.removedRows };
    case "failed": return { kind: "failed", removedRows: result.removedRows, backup: result.backup };
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Follows a compaction already running in the worker until it ends, then shows how it ended. A failed read is retried. */
async function follow(
  bridge: LedgerCompactionBridge,
  show: (view: LedgerCompactionView) => void,
  pollMs: number,
  signal: AbortSignal | undefined,
): Promise<LedgerCompactionView> {
  let view: LedgerCompactionView = { kind: "running", progress: null };
  while (!signal?.aborted) {
    let status: LedgerCompactionStatusDto | undefined;
    try {
      status = await bridge.ledgerCompactionStatus();
    } catch {
      // The next read tries again.
    }
    if (status && !status.running) {
      view = status.last ? compactionResultView(status.last) : { kind: "idle" };
      show(view);
      return view;
    }
    if (status?.running) show(view = { kind: "running", progress: status.progress });
    await wait(pollMs);
  }
  return view;
}

/**
 * When Settings opens: follows a compaction still running in the worker
 * until it ends, or shows the last run's failure, which the worker reads
 * back from the ledger after a restart. Otherwise shows nothing new.
 */
export async function resumeLedgerCompaction(
  bridge: LedgerCompactionBridge,
  show: (view: LedgerCompactionView) => void,
  { pollMs = 1000, signal }: Readonly<{ pollMs?: number; signal?: AbortSignal }> = {},
): Promise<void> {
  let status: LedgerCompactionStatusDto;
  try {
    status = await bridge.ledgerCompactionStatus();
  } catch {
    return;
  }
  if (!status.running) {
    if (status.last?.status === "failed") show(compactionResultView(status.last));
    return;
  }
  await follow(bridge, show, pollMs, signal);
}

/**
 * Runs the compaction and reports its progress every `pollMs` until it
 * ends. When one is already running, follows that one instead.
 */
export async function runLedgerCompaction(
  bridge: LedgerCompactionBridge,
  request: Readonly<{ backup: boolean }>,
  show: (view: LedgerCompactionView) => void,
  { pollMs = 1000, signal }: Readonly<{ pollMs?: number; signal?: AbortSignal }> = {},
): Promise<LedgerCompactionView> {
  show({ kind: "running", progress: null });
  let ended = false;
  const timer = setInterval(() => {
    void bridge.ledgerCompactionStatus().then(
      (status) => { if (!ended && status.running) show({ kind: "running", progress: status.progress }); },
      () => {},
    );
  }, pollMs);
  let result: LedgerCompactionResultDto | undefined;
  try {
    result = await bridge.compactLedger(request);
  } catch {
    // Shown as failed below.
  } finally {
    ended = true;
    clearInterval(timer);
  }
  if (result?.status === "already-running") return follow(bridge, show, pollMs, signal);
  const view = result ? compactionResultView(result) : FAILED;
  show(view);
  return view;
}
