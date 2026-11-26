import { basename } from "node:path";
import { listDamagedLedgers, readDamagedLedgers, removeDamagedLedger } from "../src/ledger/pglite/data-dir-backup.ts";
import type { DamagedLedgerHold, DamagedLedgerSummaryDto } from "../src/lib/desktop/api.ts";
import { NODE_RESTORE_FS, restoreHold, type LedgerRestoreFs } from "./ledger-restore.ts";

/**
 * The damaged ledgers the unusable-ledger dialog set aside (ADR 0150), as
 * Reset ledger offers them: one option for all of them, read and deleted
 * here in the main process. The renderer gets a count, a size and a reason,
 * never a path or a name.
 */

/** A restore file keeps the damaged ledgers; deleting them on their own is refused. */
export class DamagedLedgersHeld extends Error {
  override readonly name = "DamagedLedgersHeld";
  readonly hold: DamagedLedgerHold;

  constructor(hold: DamagedLedgerHold) {
    super(`The damaged ledgers cannot be deleted on their own: ${hold}.`);
    this.hold = hold;
  }
}

/** How strongly each hold keeps them: the strongest over any of them is the one the dialog says. */
const STRENGTH: Readonly<Record<DamagedLedgerHold, number>> = {
  "restore-under-way": 1,
  "restore-unreadable": 2,
  "restore-request-unreadable": 3,
};

async function holdOver(dataDir: string, paths: readonly string[], fs: LedgerRestoreFs): Promise<DamagedLedgerHold | null> {
  let hold: DamagedLedgerHold | null = null;
  for (const path of paths) {
    const next = await restoreHold(dataDir, basename(path), fs);
    if (next && (hold === null || STRENGTH[next] > STRENGTH[hold])) hold = next;
  }
  return hold;
}

/** How many damaged ledgers there are, what they take together, and whether a restore keeps them; null for none. */
export async function damagedLedgerSummary(dataDir: string, fs: LedgerRestoreFs = NODE_RESTORE_FS): Promise<DamagedLedgerSummaryDto | null> {
  const ledgers = await readDamagedLedgers(dataDir);
  if (ledgers.length === 0) return null;
  const bytes = ledgers.every((ledger) => ledger.bytes !== null)
    ? ledgers.reduce((total, ledger) => total + ledger.bytes!, 0)
    : null;
  return { count: ledgers.length, bytes, hold: await holdOver(dataDir, ledgers.map((ledger) => ledger.path), fs) };
}

/** Some damaged ledgers could not be removed; the others were. Only error codes, never a path. */
export class DamagedLedgersNotAllDeleted extends Error {
  override readonly name = "DamagedLedgersNotAllDeleted";
  readonly codes: readonly string[];

  constructor(codes: readonly string[]) {
    super(`damaged-ledgers-not-all-deleted: ${codes.join(", ")}`);
    this.codes = codes;
  }
}

const errorCode = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/u.test(code) ? code : "unknown";
};

/**
 * Reset ledger's damaged-ledger part on its own: removes every damaged
 * ledger, each renamed to `.partial` first, and nothing else. Refuses, with
 * nothing removed, while a restore file names one or cannot be read. A
 * ledger that cannot be removed does not stop the others: as many go as
 * can, then the part fails, logged by code. A ledger renamed aside whose
 * removal then failed no longer lists, and the next open removes it: it
 * counts as removed, and `log` gets its code.
 */
export async function deleteDamagedLedgers(
  dataDir: string,
  log: (code: string, detail?: string) => void,
  fs: LedgerRestoreFs = NODE_RESTORE_FS,
): Promise<void> {
  const ledgers = await listDamagedLedgers(dataDir);
  const hold = await holdOver(dataDir, ledgers, fs);
  if (hold) throw new DamagedLedgersHeld(hold);
  const failed: string[] = [];
  for (const ledger of ledgers) {
    let removal: Awaited<ReturnType<typeof removeDamagedLedger>>;
    try {
      removal = await removeDamagedLedger(ledger);
    } catch (error) {
      failed.push(errorCode(error));
      log("damaged-ledger-delete-failed", errorCode(error));
      continue;
    }
    if (removal.kind === "left-for-sweep") log("damaged-ledger-delete-left-for-sweep", removal.code);
  }
  if (failed.length > 0) throw new DamagedLedgersNotAllDeleted(failed);
}
