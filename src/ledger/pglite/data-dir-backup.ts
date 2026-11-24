import { execFile } from "node:child_process";
import { access, cp, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
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
 * On the worker that transaction also runs as one step on the background
 * lane, so no scheduled job is between two of its queries either. The size
 * walk before it and the flush after it run outside the step and the lock.
 *
 * The copy is written under a `.partial` name and renamed only once it is
 * flushed, so a folder named like a backup is always a whole one. A backup
 * whose name could not be flushed is renamed back and removed, so a backup
 * reported as failed never leaves one.
 */

/** Free space a backup leaves beyond its copy, for the WAL the compaction writes next. */
export const LEDGER_BACKUP_HEADROOM_BYTES = 256 * 1024 * 1024;
/** And this share of the folder on top, as the folder grows while the compaction runs. */
export const LEDGER_BACKUP_HEADROOM_SHARE = 0.1;

/**
 * Free bytes a backup of a folder of `storeBytes` needs. A clone on APFS
 * costs almost nothing when it is made, but it keeps the old blocks once the
 * compaction rewrites the tables, so it ends up costing the folder's size
 * too; the rule is the same whether the disk clones or not.
 */
export function ledgerBackupBytesNeeded(storeBytes: number): number {
  return storeBytes + Math.ceil(storeBytes * LEDGER_BACKUP_HEADROOM_SHARE) + LEDGER_BACKUP_HEADROOM_BYTES;
}

export type LedgerBackupRoom = Readonly<{
  /** What the ledger's folder takes now, WAL included. */
  storeBytes: number;
  /** `ledgerBackupBytesNeeded(storeBytes)`: what a backup needs free. */
  neededBytes: number;
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

const BACKUP_INFIX = ".before-compaction-";
const PARTIAL_SUFFIX = ".partial";
/** Beside a `.partial` copy `cp` writes: the pid of the process writing it. */
const PID_SUFFIX = ".pid";

/** Where a backup goes: beside the folder, named by when it was taken, never over an earlier one. */
export function ledgerBackupPath(dataDir: string, now: Date, exists: (path: string) => boolean): string {
  // A trailing separator would put the backup inside the folder.
  dataDir = resolve(dataDir);
  const stamp = now.toISOString().replaceAll(":", "-").replace(/\.\d+Z$/u, "Z");
  for (let attempt = 0; ; attempt += 1) {
    const candidate = `${dataDir}${BACKUP_INFIX}${stamp}${attempt === 0 ? "" : `-${attempt}`}`;
    if (!exists(candidate) && !exists(`${candidate}${PARTIAL_SUFFIX}`)) return candidate;
  }
}

/**
 * Removes the `.partial` copies a backup cut short left beside `dataDir`,
 * such as one the app quit during. Never touches a finished backup.
 *
 * A worker killed while `cp` copies leaves `cp` running, and it would go on
 * writing the copy while it is removed. So the `cp` named in the copy's pid
 * file is killed first, and waited for.
 */
export async function removePartialLedgerBackups(dataDir: string): Promise<void> {
  dataDir = resolve(dataDir);
  const prefix = `${basename(dataDir)}${BACKUP_INFIX}`;
  let names: string[];
  try {
    names = await readdir(dirname(dataDir));
  } catch {
    return;
  }
  const partials = new Set(names
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.endsWith(PARTIAL_SUFFIX + PID_SUFFIX) ? name.slice(0, -PID_SUFFIX.length) : name)
    .filter((name) => name.endsWith(PARTIAL_SUFFIX)));
  for (const name of partials) {
    const partial = join(dirname(dataDir), name);
    await stopCopyInto(partial);
    await rm(partial, { recursive: true, force: true });
    await rm(`${partial}${PID_SUFFIX}`, { force: true });
  }
}

/** Kills the process the pid file beside `partial` names, if it is still the one copying into `partial`. */
async function stopCopyInto(partial: string): Promise<void> {
  const pid = Number.parseInt(await readFile(`${partial}${PID_SUFFIX}`, "utf8").catch(() => ""), 10);
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  // The pid may have gone to another process since: only one whose arguments name the copy is killed.
  const args = await run("/bin/ps", ["-ww", "-o", "args=", "-p", String(pid)]).then(({ stdout }) => stdout, () => "");
  if (!args.includes(partial)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  for (let waited = 0; waited < 10_000 && isAlive(pid); waited += 20) await new Promise((done) => setTimeout(done, 20));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type LedgerBackupCopy = (from: string, to: string, signal: AbortSignal | undefined) => Promise<void>;

export type LedgerBackupOptions = Readonly<{
  freeBytes: () => Promise<number>;
  now?: () => Date;
  exists: (path: string) => boolean;
  /** Runs the CHECKPOINT and the copy as one step; the worker passes its background lane's. */
  runStep?: <T>(step: () => Promise<T>) => Promise<T>;
  /** Aborts the copy between files and the flush; the partial copy is removed. */
  signal?: AbortSignal;
  /** Copies the folder; checks replace it to write while it runs. */
  copyFolder?: LedgerBackupCopy;
  /** Flushes the folder that holds the backup's name once it is renamed; checks replace it to fail. */
  flushEntry?: (folder: string) => Promise<void>;
}>;

const run = promisify(execFile);

/** Copies byte by byte, checking `signal` before each file. */
const byteCopy: LedgerBackupCopy = (from, to, signal) =>
  cp(from, to, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: () => { signal?.throwIfAborted(); return true; },
  });

/**
 * On macOS, `cp -c` clones each file (clonefile(2)): on APFS a 1 GB file
 * takes milliseconds and no space. Node's `fs.cp` and `copyFile` with
 * `COPYFILE_FICLONE` still copy every byte there, and `COPYFILE_FICLONE_FORCE`
 * fails with ENOSYS. On a disk that cannot clone, such as HFS+ or exFAT,
 * `cp -c` copies the bytes itself.
 *
 * The byte copy runs instead only when `cp` fails before it wrote anything,
 * as one that does not know `-c` does. A `cp` that fails partway, such as on
 * ENOSPC or EACCES, has held the lock for most of a copy already; the backup
 * fails rather than hold it as long again.
 *
 * A shell writes its pid beside the copy and then becomes `cp`, so the pid
 * file exists before `cp` writes anything, and names `cp` until it ends. If
 * the worker is killed, `cp` goes on; `removePartialLedgerBackups` kills it.
 *
 * `cloneBinary` is `/bin/cp` on macOS; checks pass a stand-in.
 */
export function ledgerFolderCopy(cloneBinary: string | undefined): LedgerBackupCopy {
  return async (from, to, signal) => {
    if (cloneBinary !== undefined) {
      const pidFile = `${to}${PID_SUFFIX}`;
      try {
        await run("/bin/sh", ["-c", 'printf %s "$$" > "$1" && exec "$2" -cR "$3" "$4"', "sh", pidFile, cloneBinary, from, to], { signal });
        return;
      } catch (error) {
        signal?.throwIfAborted();
        if (await exists(to)) throw error;
      } finally {
        await rm(pidFile, { force: true });
      }
    }
    await byteCopy(from, to, signal);
  };
}

const exists = (path: string) => access(path).then(() => true, () => false);

const cloneOrCopy = ledgerFolderCopy(process.platform === "darwin" ? "/bin/cp" : undefined);

async function fsyncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function ledgerBackupRoom(dataDir: string, freeBytes: () => Promise<number>): Promise<LedgerBackupRoom> {
  const [storeBytes, free] = await Promise.all([directoryBytes(dataDir), freeBytes()]);
  return { storeBytes, neededBytes: ledgerBackupBytesNeeded(storeBytes), freeBytes: free };
}

/**
 * Copies `dataDir` beside itself while `store` writes nothing, flushes the
 * copy to the disk, then gives it its name. Refuses when the disk has less
 * free than `ledgerBackupBytesNeeded`. A copy that fails or is aborted is
 * removed. Returns where the copy went, which stays in the worker: the
 * renderer is never told a path.
 */
export async function backUpLedger(store: PGliteStore, dataDir: string, options: LedgerBackupOptions): Promise<string> {
  const { signal } = options;
  dataDir = resolve(dataDir);
  await removePartialLedgerBackups(dataDir);
  const room = await ledgerBackupRoom(dataDir, options.freeBytes);
  if (room.freeBytes < room.neededBytes) {
    throw new LedgerBackupError("no-room", `A backup needs ${room.neededBytes} bytes free; ${room.freeBytes} are free.`);
  }
  const target = ledgerBackupPath(dataDir, (options.now ?? (() => new Date()))(), options.exists);
  const partial = `${target}${PARTIAL_SUFFIX}`;
  const copyFolder = options.copyFolder ?? cloneOrCopy;
  let named = false;
  try {
    await (options.runStep ?? ((step) => step()))(() => store.transaction(async (transaction) => {
      signal?.throwIfAborted();
      await transaction.query("CHECKPOINT");
      await copyFolder(dataDir, partial, signal);
    }));
    // The copy is already consistent, so its flush holds neither the lock nor the lane.
    await fsyncDirectory(partial, undefined, signal);
    signal?.throwIfAborted();
    await rename(partial, target);
    named = true;
    await (options.flushEntry ?? fsyncPath)(dirname(target));
  } catch (error) {
    // A name that may not survive a crash is no backup: it goes back to `.partial` and is removed with the copy.
    if (named) await rename(target, partial).catch(() => rm(target, { recursive: true, force: true }));
    await rm(partial, { recursive: true, force: true });
    if (signal?.aborted) throw error;
    throw new LedgerBackupError("copy-failed", error instanceof Error ? error.message : String(error));
  }
  return target;
}
