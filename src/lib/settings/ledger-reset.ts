import type { LedgerResetPart, LedgerResetResult } from "../desktop/api.ts";
import { LEDGER_RESET_PARTS } from "./data-erasure.ts";

/** One box in the Reset ledger dialog. A locked box is ticked because another part includes it. */
export type LedgerResetOption = Readonly<{ part: LedgerResetPart; checked: boolean; locked: boolean }>;

export type LedgerResetChoices = Readonly<{
  options: readonly LedgerResetOption[];
  /** What the confirm button deletes, in the order the main process runs them. */
  parts: readonly LedgerResetPart[];
  canConfirm: boolean;
}>;

/**
 * The dialog's boxes from what the person ticked. The Canonical Reset
 * deletes Preview Financial Data too, so while it is ticked the preview box
 * is ticked and locked; unticking it gives the preview box back as it was.
 */
export function ledgerResetChoices(ticked: ReadonlySet<LedgerResetPart>): LedgerResetChoices {
  const options = LEDGER_RESET_PARTS.map((part) => {
    const locked = part === "preview" && ticked.has("financial");
    return { part, checked: locked || ticked.has(part), locked };
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
  if (part === "preview" && ticked.has("financial")) return ticked;
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
