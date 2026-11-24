import type {
  LedgerReclaimEstimateDto,
  LedgerReclaimProgressDto,
  LedgerReclaimResultDto,
  LedgerReclaimStatusDto,
} from "../desktop/api.ts";

/** What the Reclaim ledger space row shows (ADR 0155). */
export type LedgerReclaimView =
  | Readonly<{ kind: "idle" | "checking" | "nothing" }>
  | Readonly<{ kind: "estimated"; reclaimableBytes: number }>
  | Readonly<{ kind: "no-room"; requiredFreeBytes: number; freeBytes: number }>
  | Readonly<{ kind: "running"; progress: LedgerReclaimProgressDto | null }>
  /** `failed` keeps what the tables rewritten before the failure reclaimed. */
  | Readonly<{ kind: "done" | "stopped" | "failed"; reclaimedBytes: number }>;

export type LedgerReclaimBridge = Readonly<{
  reclaimLedgerSpace(): Promise<LedgerReclaimResultDto>;
  ledgerReclaimStatus(): Promise<LedgerReclaimStatusDto>;
}>;

const FAILED: LedgerReclaimView = { kind: "failed", reclaimedBytes: 0 };

/** Megabytes for the copy: whole numbers from 10 MB, one decimal below. */
export function megabytes(bytes: number): string {
  const value = bytes / (1024 * 1024);
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}

export function estimateView(estimate: LedgerReclaimEstimateDto): LedgerReclaimView {
  if (estimate.tableCount === 0) return { kind: "nothing" };
  if (estimate.freeBytes !== null && estimate.freeBytes < estimate.requiredFreeBytes) {
    return { kind: "no-room", requiredFreeBytes: estimate.requiredFreeBytes, freeBytes: estimate.freeBytes };
  }
  return { kind: "estimated", reclaimableBytes: estimate.reclaimableBytes };
}

export function resultView(result: LedgerReclaimResultDto): LedgerReclaimView {
  switch (result.status) {
    case "nothing-to-reclaim": return { kind: "nothing" };
    case "not-enough-space": return { kind: "no-room", requiredFreeBytes: result.requiredFreeBytes, freeBytes: result.freeBytes };
    case "already-running": return { kind: "running", progress: null };
    case "reclaimed": return { kind: "done", reclaimedBytes: result.reclaimedBytes };
    case "stopped": return { kind: "stopped", reclaimedBytes: result.reclaimedBytes };
    case "failed": return { kind: "failed", reclaimedBytes: result.reclaimedBytes };
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Follows a reclaim already running in the worker, such as one started
 * before Settings was left, until it ends, then shows how it ended.
 * A failed read is retried.
 */
async function follow(
  bridge: LedgerReclaimBridge,
  show: (view: LedgerReclaimView) => void,
  pollMs: number,
  signal: AbortSignal | undefined,
): Promise<LedgerReclaimView> {
  let view: LedgerReclaimView = { kind: "running", progress: null };
  while (!signal?.aborted) {
    let status: LedgerReclaimStatusDto | undefined;
    try {
      status = await bridge.ledgerReclaimStatus();
    } catch {
      // The next read tries again.
    }
    if (status && !status.running) {
      view = status.last ? resultView(status.last) : { kind: "idle" };
      show(view);
      return view;
    }
    if (status?.running) show(view = { kind: "running", progress: status.progress });
    await wait(pollMs);
  }
  return view;
}

/**
 * Shows a reclaim that is still running when Settings opens, until it ends;
 * otherwise shows nothing new. `signal` stops following once Settings closes.
 */
export async function resumeLedgerReclaim(
  bridge: LedgerReclaimBridge,
  show: (view: LedgerReclaimView) => void,
  { pollMs = 1000, signal }: Readonly<{ pollMs?: number; signal?: AbortSignal }> = {},
): Promise<void> {
  try {
    if (!(await bridge.ledgerReclaimStatus()).running) return;
  } catch {
    return;
  }
  await follow(bridge, show, pollMs, signal);
}

/**
 * Runs the reclaim and reports its progress every `pollMs` until it ends.
 * When one is already running, follows that one instead.
 */
export async function runLedgerReclaim(
  bridge: LedgerReclaimBridge,
  show: (view: LedgerReclaimView) => void,
  { pollMs = 1000, signal }: Readonly<{ pollMs?: number; signal?: AbortSignal }> = {},
): Promise<LedgerReclaimView> {
  show({ kind: "running", progress: null });
  let ended = false;
  const timer = setInterval(() => {
    void bridge.ledgerReclaimStatus().then(
      (status) => { if (!ended && status.running) show({ kind: "running", progress: status.progress }); },
      () => {},
    );
  }, pollMs);
  let result: LedgerReclaimResultDto | undefined;
  try {
    result = await bridge.reclaimLedgerSpace();
  } catch {
    // Shown as failed below.
  } finally {
    ended = true;
    clearInterval(timer);
  }
  if (result?.status === "already-running") return follow(bridge, show, pollMs, signal);
  const view = result ? resultView(result) : FAILED;
  show(view);
  return view;
}
