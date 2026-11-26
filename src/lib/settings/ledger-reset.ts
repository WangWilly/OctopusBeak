import type { DamagedLedgerHold, DamagedLedgerSummaryDto, LedgerResetPart, LedgerResetResult } from "../desktop/api.ts";
import type { SettingsCopy } from "./copy.ts";
import { LEDGER_RESET_PARTS } from "./data-erasure.ts";

/**
 * One box in the Reset ledger dialog. A locked box is ticked because another
 * part includes it. A box `held` by a restore cannot be ticked on its own;
 * the dialog says why.
 */
export type LedgerResetOption = Readonly<{ part: LedgerResetPart; checked: boolean; locked: boolean; held: DamagedLedgerHold | null }>;

export type LedgerResetChoices = Readonly<{
  options: readonly LedgerResetOption[];
  /** What the confirm button deletes, in the order the main process runs them. */
  parts: readonly LedgerResetPart[];
  canConfirm: boolean;
}>;

/** Parts the Canonical Reset deletes too: ticking financial data ticks and locks them. */
const INCLUDED_IN_FINANCIAL: ReadonlySet<LedgerResetPart> = new Set(["preview", "damaged"]);

/**
 * The dialog's boxes from what the person ticked. The Canonical Reset
 * deletes Preview Financial Data and the damaged ledgers too, so while it is
 * ticked those boxes are ticked and locked; unticking it gives them back as
 * they were. The damaged-ledger box shows only while `damaged` says one
 * exists; a restore that keeps them leaves it unticked unless locked.
 */
export function ledgerResetChoices(
  ticked: ReadonlySet<LedgerResetPart>,
  damaged: DamagedLedgerSummaryDto | null = null,
): LedgerResetChoices {
  const options = LEDGER_RESET_PARTS.filter((part) => part !== "damaged" || damaged !== null).map((part) => {
    const locked = INCLUDED_IN_FINANCIAL.has(part) && ticked.has("financial");
    const held = part === "damaged" && !locked ? damaged?.hold ?? null : null;
    return { part, checked: locked || (held === null && ticked.has(part)), locked, held };
  });
  const parts = options.filter((option) => option.checked).map((option) => option.part);
  return { options, parts, canConfirm: parts.length > 0 };
}

/** The person's ticks after one box changed; a locked box does not change. */
export function tickLedgerResetPart(
  ticked: ReadonlySet<LedgerResetPart>,
  part: LedgerResetPart,
  checked: boolean,
): ReadonlySet<LedgerResetPart> {
  if (INCLUDED_IN_FINANCIAL.has(part) && ticked.has("financial")) return ticked;
  const next = new Set(ticked);
  if (checked) next.add(part);
  else next.delete(part);
  return next;
}

/**
 * How a reset ended, as the data section shows it. `failed: null` is a
 * reset that did not run or whose answer never came, such as one refused
 * while a cleanup runs: nothing is known to be done.
 */
export type LedgerResetOutcome =
  | Readonly<{ kind: "done"; done: readonly LedgerResetPart[] }>
  | Readonly<{
    kind: "failed";
    done: readonly LedgerResetPart[];
    failed: LedgerResetPart | null;
    notRun: readonly LedgerResetPart[];
  }>;

export function ledgerResetOutcome(result: LedgerResetResult): LedgerResetOutcome {
  return result.failed === null ? { kind: "done", done: result.done } : { kind: "failed", ...result };
}

/** Runs the reset in the main process; a refused or failed call reports nothing done. */
export async function runLedgerReset(
  bridge: Readonly<{ resetLedger(parts: readonly LedgerResetPart[]): Promise<LedgerResetResult> }>,
  parts: readonly LedgerResetPart[],
): Promise<LedgerResetOutcome> {
  try {
    return ledgerResetOutcome(await bridge.resetLedger(parts));
  } catch {
    return { kind: "failed", done: [], failed: null, notRun: parts };
  }
}

/**
 * What the data section says after a reset that did not finish. The
 * Canonical Reset removes the Cleanup Backup before it empties the store, so
 * a failed one may already have deleted that backup, and a failed
 * damaged-ledger part may have removed some of them: neither says nothing
 * was deleted.
 */
export function ledgerResetFailureText(
  outcome: Extract<LedgerResetOutcome, { kind: "failed" }>,
  copy: SettingsCopy["settings"],
): string {
  const list = (parts: readonly LedgerResetPart[]) =>
    parts.length > 0 ? copy.resetLedgerList(parts.map((part) => copy.resetLedgerParts[part])) : null;
  if (outcome.failed === null) return copy.resetLedgerNotRun;
  if (outcome.failed === "financial") return copy.resetLedgerFinancialFailed(list(outcome.notRun));
  // Each damaged ledger goes on its own: some may be gone, so it never says nothing was deleted.
  if (outcome.failed === "damaged") return copy.resetLedgerDamagedFailed(list(outcome.done), list(outcome.notRun));
  return copy.resetLedgerFailed(copy.resetLedgerParts[outcome.failed], list(outcome.done), list(outcome.notRun));
}
