import type { DataVersionReason, DataVersionStore } from "../shared-shell/data-version.ts";

export type CollectionControl = Readonly<{
  /** Stops scheduled collection and returns its resume. */
  pauseSchedules(): () => void;
  /** Cancels every run, waits until each is terminal, and runs `work` before any new run starts. */
  whileStopped<T>(work: () => Promise<T>): Promise<T>;
}>;

/**
 * What Reset ledger can delete, in the order it deletes them: the Canonical
 * Reset, Preview Financial Data, Manual Assets, and the Sign-in Erasure. The
 * reset goes first, so a sign-in erasure that replaces the Card identity
 * secret after it finds no card account to split.
 */
export const LEDGER_RESET_PARTS = ["financial", "preview", "manual", "sign-in"] as const;
export type LedgerResetPart = (typeof LEDGER_RESET_PARTS)[number];

/** Each deletion on its own; none stops collection, which the batch does once. */
export type LedgerResetSteps = Readonly<Record<LedgerResetPart, () => Promise<void>>>;

/** What finished, the part that failed, and what did not run because of it. */
export type LedgerResetResult = Readonly<{
  done: readonly LedgerResetPart[];
  failed: LedgerResetPart | null;
  notRun: readonly LedgerResetPart[];
}>;

/** Manual Assets move no data version: their live views follow the ledger's revision. */
const STALE: Readonly<Record<LedgerResetPart, DataVersionReason | null>> = {
  financial: "financial-data-deleted",
  preview: "preview-data-changed",
  manual: null,
  "sign-in": "sign-in-data-cleared",
};

/**
 * Reset ledger from Settings. Collection stops once for the whole batch and
 * no collection starts afterwards. The parts run in their fixed order and
 * the first that fails stops the rest; each part that finished marks its
 * views stale. The Canonical Reset already deletes Preview Financial Data,
 * so preview data asked for beside it is done once the reset is.
 */
export async function resetLedger(
  collection: CollectionControl,
  steps: LedgerResetSteps,
  versions: Pick<DataVersionStore, "markStale">,
  parts: ReadonlySet<LedgerResetPart>,
): Promise<LedgerResetResult> {
  const order = LEDGER_RESET_PARTS.filter((part) => parts.has(part));
  const done: LedgerResetPart[] = [];
  let failed: LedgerResetPart | null = null;
  const resume = collection.pauseSchedules();
  try {
    await collection.whileStopped(async () => {
      for (const part of order) {
        if (part === "preview" && done.includes("financial")) {
          done.push(part);
          continue;
        }
        try {
          await steps[part]();
        } catch {
          // Only the part's name: an error may carry a path or a source's details.
          console.error("ledger-reset-failed", part);
          failed = part;
          return;
        }
        done.push(part);
        const reason = STALE[part];
        if (reason) versions.markStale(reason);
      }
    });
  } finally {
    resume();
  }
  return { done, failed, notRun: order.slice(done.length + (failed ? 1 : 0)) };
}
