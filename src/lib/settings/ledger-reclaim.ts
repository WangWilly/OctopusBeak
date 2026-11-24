import type {
  LedgerReclaimEstimateDto,
  LedgerReclaimProgressDto,
  LedgerReclaimResultDto,
} from "../desktop/api.ts";

/** What the Reclaim ledger space row shows (ADR 0155). */
export type LedgerReclaimView =
  | Readonly<{ kind: "idle" | "checking" | "nothing" | "failed" }>
  | Readonly<{ kind: "estimated"; reclaimableBytes: number }>
  | Readonly<{ kind: "no-room"; requiredFreeBytes: number; freeBytes: number }>
  | Readonly<{ kind: "running"; progress: LedgerReclaimProgressDto | null }>
  | Readonly<{ kind: "done" | "stopped"; reclaimedBytes: number }>;

export type LedgerReclaimBridge = Readonly<{
  ledgerReclaimEstimate(): Promise<LedgerReclaimEstimateDto>;
  reclaimLedgerSpace(): Promise<LedgerReclaimResultDto>;
  ledgerReclaimProgress(): Promise<LedgerReclaimProgressDto | null>;
}>;

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
    case "reclaimed": return { kind: "done", reclaimedBytes: result.reclaimedBytes };
    case "stopped": return { kind: "stopped", reclaimedBytes: result.reclaimedBytes };
    // The page starts one reclaim at a time, so another one running is a fault like a failed table.
    case "already-running":
    case "failed": return { kind: "failed" };
  }
}

/**
 * Runs the reclaim and reports its progress every `pollMs` until it ends.
 * A failed progress read keeps the last progress shown.
 */
export async function runLedgerReclaim(
  bridge: LedgerReclaimBridge,
  show: (view: LedgerReclaimView) => void,
  pollMs = 1000,
): Promise<LedgerReclaimView> {
  show({ kind: "running", progress: null });
  let ended = false;
  const timer = setInterval(() => {
    void bridge.ledgerReclaimProgress().then(
      (progress) => { if (!ended && progress) show({ kind: "running", progress }); },
      () => {},
    );
  }, pollMs);
  let view: LedgerReclaimView;
  try {
    view = resultView(await bridge.reclaimLedgerSpace());
  } catch {
    view = { kind: "failed" };
  } finally {
    ended = true;
    clearInterval(timer);
  }
  show(view);
  return view;
}
