import type { DamagedLedgerDto } from "../desktop/api.ts";

/**
 * The damaged ledgers row (ADR 0150): one line per ledger the unusable-ledger
 * dialog set aside, newest first, each with Show in Finder and Delete. The
 * main process lists and deletes; the row knows each only by its id.
 */
export type DamagedLedgersView = Readonly<{
  ledgers: readonly DamagedLedgerDto[];
  action: DamagedLedgerAction;
}>;

export type DamagedLedgerAction =
  | Readonly<{ kind: "idle" | "deleted" }>
  /** `confirming`: its one-step confirm is open; `failed`: its deletion was refused or failed. */
  | Readonly<{ kind: "confirming" | "deleting" | "failed"; id: string }>;

export type DamagedLedgersBridge = Readonly<{
  damagedLedgers(): Promise<readonly DamagedLedgerDto[]>;
  deleteDamagedLedger(id: string): Promise<readonly DamagedLedgerDto[]>;
}>;

export const NO_DAMAGED_LEDGERS: DamagedLedgersView = { ledgers: [], action: { kind: "idle" } };

/**
 * What the row shows: `ledgers` while a damaged ledger exists, with the
 * hint about what one may hold; `all-deleted` once the last is deleted,
 * only to say so; `hidden` otherwise.
 */
export function damagedLedgersShown(view: DamagedLedgersView): "ledgers" | "all-deleted" | "hidden" {
  if (view.ledgers.length > 0) return "ledgers";
  return view.action.kind === "deleted" ? "all-deleted" : "hidden";
}

/**
 * The ledgers as read now. A step under way for one that is gone, or that a
 * restore file now keeps, ends: its line says why instead. A failed read
 * keeps what was read last.
 */
export async function readDamagedLedgers(bridge: DamagedLedgersBridge, view: DamagedLedgersView): Promise<DamagedLedgersView> {
  let ledgers: readonly DamagedLedgerDto[];
  try {
    ledgers = await bridge.damagedLedgers();
  } catch {
    return view;
  }
  const { action } = view;
  const kept = !("id" in action) || ledgers.some((ledger) => ledger.id === action.id && ledger.deletable);
  return { ledgers, action: kept ? action : { kind: "idle" } };
}

/** Opens the confirm for one ledger; another's confirm or notice closes. One a restore file keeps has no Delete to confirm. */
export function confirmDamagedLedgerDelete(view: DamagedLedgersView, id: string): DamagedLedgersView {
  if (view.action.kind === "deleting" || !view.ledgers.some((ledger) => ledger.id === id && ledger.deletable)) return view;
  return { ...view, action: { kind: "confirming", id } };
}

export function cancelDamagedLedgerDelete(view: DamagedLedgersView): DamagedLedgersView {
  return view.action.kind === "confirming" ? { ...view, action: { kind: "idle" } } : view;
}

/**
 * Deletes the ledger whose confirm is open. Shows what the host says is
 * left; a refusal or failure keeps the ledger, says so beside it, and reads
 * the list again, since it may have changed meanwhile.
 */
export async function deleteDamagedLedger(
  bridge: DamagedLedgersBridge,
  view: DamagedLedgersView,
  show: (view: DamagedLedgersView) => void,
): Promise<DamagedLedgersView> {
  if (view.action.kind !== "confirming") return view;
  const { id } = view.action;
  show(view = { ...view, action: { kind: "deleting", id } });
  try {
    view = { ledgers: await bridge.deleteDamagedLedger(id), action: { kind: "deleted" } };
  } catch {
    view = await readDamagedLedgers(bridge, { ...view, action: { kind: "failed", id } });
  }
  show(view);
  return view;
}
