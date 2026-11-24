import { cp, rm } from "node:fs/promises";
import { directoryBytes, fsyncDirectory } from "./data-dir-files.ts";
import type { PGliteStore } from "./transaction.ts";

/**
 * The opt-in backup a ledger compaction takes first (ADR 0154): a copy of
 * the ledger's data folder, beside it, consistent as of one moment.
 *
 * The copy is made inside one transaction of the store, after a CHECKPOINT
 * in it. PGlite runs a transaction under its transaction mutex, which every
 * other `query`, `exec` and `transaction` call waits for, live queries and
 * the operational server included. So nothing writes to the folder while it
 * is copied, and the CHECKPOINT has written every dirty page to the data
 * files first. The copy opens as a store that stopped at that checkpoint.
 * On the worker the backup also runs as one step on the background lane, so
 * no scheduled job is between two of its queries either.
 */

export type LedgerBackupRoom = Readonly<{
  /** What the ledger's folder takes now, WAL included; a backup needs this much free. */
  storeBytes: number;
  freeBytes: number;
}>;

export class LedgerBackupError extends Error {
  /** `unavailable`: the ledger has no folder of its own, such as a worker's temporary one. */
  readonly reason: "no-room" | "copy-failed" | "unavailable";

  constructor(reason: LedgerBackupError["reason"], message: string) {
    super(message);
    this.name = "LedgerBackupError";
    this.reason = reason;
  }
}

/** Where a backup goes: beside the folder, named by when it was taken, never over an earlier one. */
export function ledgerBackupPath(dataDir: string, now: Date, exists: (path: string) => boolean): string {
  const stamp = now.toISOString().replaceAll(":", "-").replace(/\.\d+Z$/u, "Z");
  for (let attempt = 0; ; attempt += 1) {
    const candidate = `${dataDir}.before-compaction-${stamp}${attempt === 0 ? "" : `-${attempt}`}`;
    if (!exists(candidate)) return candidate;
  }
}

export type LedgerBackupOptions = Readonly<{
  freeBytes: () => Promise<number>;
  now?: () => Date;
  exists: (path: string) => boolean;
  /** Copies the folder; checks replace it to write while it runs. */
  copyFolder?: (from: string, to: string) => Promise<void>;
}>;

const copyFolder = (from: string, to: string) => cp(from, to, { recursive: true, errorOnExist: true, force: false });

export async function ledgerBackupRoom(dataDir: string, freeBytes: () => Promise<number>): Promise<LedgerBackupRoom> {
  const [storeBytes, free] = await Promise.all([directoryBytes(dataDir), freeBytes()]);
  return { storeBytes, freeBytes: free };
}

/**
 * Copies `dataDir` beside itself while `store` writes nothing, then flushes
 * the copy to the disk. Refuses when the disk has less free than the folder
 * takes. A copy that fails is removed. Returns where the copy went, which
 * stays in the worker: the renderer is never told a path.
 */
export async function backUpLedger(store: PGliteStore, dataDir: string, options: LedgerBackupOptions): Promise<string> {
  const room = await ledgerBackupRoom(dataDir, options.freeBytes);
  if (room.freeBytes < room.storeBytes) {
    throw new LedgerBackupError("no-room", `A backup needs ${room.storeBytes} bytes free; ${room.freeBytes} are free.`);
  }
  const target = ledgerBackupPath(dataDir, (options.now ?? (() => new Date()))(), options.exists);
  try {
    await store.transaction(async (transaction) => {
      await transaction.query("CHECKPOINT");
      await (options.copyFolder ?? copyFolder)(dataDir, target);
    });
    await fsyncDirectory(target);
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw new LedgerBackupError("copy-failed", error instanceof Error ? error.message : String(error));
  }
  return target;
}
