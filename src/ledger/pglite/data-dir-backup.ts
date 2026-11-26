import { execFile } from "node:child_process";
import { access, cp, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { directoryBytes, fsyncDirectory } from "./data-dir-files.ts";
import type { PGliteStore } from "./transaction.ts";

/**
 * The Cleanup Backup an App Data Cleanup takes first (ADR 0154, ADR 0156):
 * a copy of the ledger's data folder, beside it, consistent as of one moment.
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

/**
 * Free bytes a cleanup with a backup needs: the backup's own need plus
 * `reserveBytes`, what the run needs after it (ADR 0156). The backup stays on
 * the disk while the reclaim runs: a byte copy has already used the folder's
 * size, and a clone keeps the old blocks of every table the reclaim
 * rewrites, so the two needs add up. The estimate and the backup's own check
 * before it copies both use this rule.
 */
export function cleanupBackupBytesNeeded(storeBytes: number, reserveBytes: number): number {
  return ledgerBackupBytesNeeded(storeBytes) + reserveBytes;
}

export type LedgerBackupRoom = Readonly<{
  /** What the ledger's folder takes now, WAL included. */
  storeBytes: number;
  /** `cleanupBackupBytesNeeded(storeBytes, reserveBytes)`: what a backup and the run after it need free. */
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
/** Beside a finished backup: the baseline versions of the store it copied. */
const VERSIONS_SUFFIX = ".versions.json";
/** Beside the ledger while a Cleanup Restore is under way (ADR 0157): it names the backup being restored. */
const RESTORE_PENDING_SUFFIX = ".restore-pending";

/** How long a backup is kept, counted from the UTC time in its name (ADR 0156). */
export const LEDGER_BACKUP_RETENTION_DAYS = 60;
const RETENTION_MS = LEDGER_BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * The canonical and operational baseline versions of a store. The worker
 * refuses to open a store of other versions, so a backup whose versions
 * differ from the App's can no longer be opened.
 */
export type LedgerBackupVersions = Readonly<{ canonical: number; operational: number }>;

/** A finished backup beside the ledger's folder. */
export type LedgerBackupEntry = Readonly<{ path: string; takenAt: Date }>;

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
  // A versions file whose backup is gone: written before a rename that never came, or left by a removal cut short.
  // A restore under way has renamed its backup into the ledger's place, and keeps that one's file until it ends.
  const restoring = await pendingRestoreBackup(dataDir);
  for (const name of names.filter((name) => name.startsWith(prefix) && name.endsWith(VERSIONS_SUFFIX))) {
    const backup = join(dirname(dataDir), name.slice(0, -VERSIONS_SUFFIX.length));
    if (backup !== restoring && !(await exists(backup))) await rm(join(dirname(dataDir), name), { force: true });
  }
}

const STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z(?:-\d+)?$/u;

/**
 * The time in the name of a backup of `dataDir`, or null when `name` is not
 * one: a bare name of the form `ledgerBackupPath` gives, with no separator,
 * so it can only name a sibling of the ledger.
 */
export function ledgerBackupTakenAt(dataDir: string, name: string): Date | null {
  const prefix = `${basename(resolve(dataDir))}${BACKUP_INFIX}`;
  if (!name.startsWith(prefix)) return null;
  const stamp = STAMP.exec(name.slice(prefix.length));
  if (!stamp) return null;
  const takenAt = new Date(`${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}Z`);
  return Number.isNaN(takenAt.getTime()) ? null : takenAt;
}

/** The file beside a backup that records the versions of the store it copied. */
export function ledgerBackupVersionsPath(backup: string): string {
  return `${backup}${VERSIONS_SUFFIX}`;
}

/** Where a Cleanup Restore records its request and how far it got (ADR 0157). */
export function ledgerRestorePendingPath(dataDir: string): string {
  return `${resolve(dataDir)}${RESTORE_PENDING_SUFFIX}`;
}

/** The pending file once the restored store has opened: renamed, so the signal needs no free space. */
export function ledgerRestoreOpenedPath(dataDir: string): string {
  return `${resolve(dataDir)}.restore-opened`;
}

/**
 * A restore file that could not be read, kept: it may have named a
 * `.replaced-` ledger, so while it exists no launch removes one. Only a
 * Canonical Reset removes it.
 */
export function ledgerRestoreUnreadablePath(dataDir: string): string {
  return `${resolve(dataDir)}.restore-unreadable`;
}

/** How the last restore ended, kept until Settings reads it. */
export function ledgerRestoreOutcomePath(dataDir: string): string {
  return `${resolve(dataDir)}.restore-outcome`;
}

const REPLACED_INFIX = ".replaced-";

/** Whether `name` is a bare name of the form a restore from Settings sets the ledger aside under. */
export function isReplacedLedgerName(dataDir: string, name: string): boolean {
  const prefix = `${basename(resolve(dataDir))}${REPLACED_INFIX}`;
  return name.startsWith(prefix) && STAMP.test(name.slice(prefix.length));
}

/**
 * Removes what a Cleanup Restore leaves beside the ledger: its files first,
 * so nothing names a folder any more, then every ledger a restore set aside
 * as `.replaced-`, which holds the financial data of before the restore.
 */
export async function removeLedgerRestoreLeftovers(dataDir: string): Promise<void> {
  dataDir = resolve(dataDir);
  for (const file of [
    ledgerRestorePendingPath(dataDir),
    ledgerRestoreOpenedPath(dataDir),
    ledgerRestoreOutcomePath(dataDir),
    ledgerRestoreUnreadablePath(dataDir),
  ]) {
    await rm(file, { force: true });
    await rm(`${file}.tmp`, { force: true });
  }
  let names: string[];
  try {
    names = await readdir(dirname(dataDir));
  } catch {
    return;
  }
  for (const name of names) {
    if (isReplacedLedgerName(dataDir, name)) await rm(join(dirname(dataDir), name), { recursive: true, force: true });
  }
}

/**
 * The backup a Cleanup Restore under way names, or null when none is under
 * way. Nothing that removes backups touches it: it is the restore's to use
 * up or to give back.
 */
export async function pendingRestoreBackup(dataDir: string): Promise<string | null> {
  dataDir = resolve(dataDir);
  let name: unknown;
  try {
    name = (JSON.parse(await readFile(ledgerRestorePendingPath(dataDir), "utf8")) as { backup?: unknown } | null)?.backup;
  } catch {
    return null;
  }
  return typeof name === "string" && ledgerBackupTakenAt(dataDir, name) ? join(dirname(dataDir), name) : null;
}

/** The finished backups beside `dataDir`, newest first. A name without a readable time is not one of them. */
export async function listLedgerBackups(dataDir: string): Promise<LedgerBackupEntry[]> {
  dataDir = resolve(dataDir);
  let names: string[];
  try {
    names = await readdir(dirname(dataDir));
  } catch {
    return [];
  }
  const backups: LedgerBackupEntry[] = [];
  for (const name of names) {
    const takenAt = ledgerBackupTakenAt(dataDir, name);
    if (!takenAt) continue;
    const path = join(dirname(dataDir), name);
    if (!(await stat(path).then((entry) => entry.isDirectory(), () => false))) continue;
    backups.push({ path, takenAt });
  }
  return backups.sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime() || b.path.localeCompare(a.path));
}

/** When a backup taken at `takenAt` expires. */
export function ledgerBackupExpiresAt(takenAt: Date): Date {
  return new Date(takenAt.getTime() + RETENTION_MS);
}

/**
 * Removes one finished backup and its versions file. It is renamed to
 * `.partial` first, so a removal cut short leaves a copy the next open
 * removes, never a half-deleted folder under a backup's name.
 */
export async function removeLedgerBackup(backup: string): Promise<void> {
  const partial = `${backup}${PARTIAL_SUFFIX}`;
  try {
    await rename(backup, partial);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rm(partial, { recursive: true, force: true });
  await rm(`${backup}${VERSIONS_SUFFIX}`, { force: true });
}

/** Removes every finished backup but `keep`, and but one a restore under way names: at most one is kept (ADR 0156). */
export async function removeOtherLedgerBackups(dataDir: string, keep: string): Promise<void> {
  const restoring = await pendingRestoreBackup(dataDir);
  for (const { path } of await listLedgerBackups(dataDir)) {
    if (path !== resolve(keep) && path !== restoring) await removeLedgerBackup(path);
  }
}

/**
 * Removes every backup whose time is `LEDGER_BACKUP_RETENTION_DAYS` or more
 * before `now`, but one a restore under way names (ADR 0157): it expires
 * once the restore gives it back.
 */
export async function removeExpiredLedgerBackups(dataDir: string, now: Date): Promise<void> {
  const restoring = await pendingRestoreBackup(dataDir);
  for (const { path, takenAt } of await listLedgerBackups(dataDir)) {
    if (path !== restoring && ledgerBackupExpiresAt(takenAt).getTime() <= now.getTime()) await removeLedgerBackup(path);
  }
}

/**
 * Removes every backup, finished or partial, and every ledger a restore set
 * aside: a Canonical Reset leaves none that holds the deleted data. Settings
 * refuses a reset once a restore is asked for, so none is under way here.
 */
export async function removeAllLedgerBackups(dataDir: string): Promise<void> {
  await removeLedgerRestoreLeftovers(dataDir);
  await removePartialLedgerBackups(dataDir);
  for (const { path } of await listLedgerBackups(dataDir)) await removeLedgerBackup(path);
  await removePartialLedgerBackups(dataDir);
}

/** The backup Settings shows: the newest finished one. `path` stays on the host. */
export type LedgerCleanupBackup = Readonly<{
  path: string;
  /** null when the folder could not be measured; it can still be deleted. */
  bytes: number | null;
  takenAt: string;
  expiresAt: string;
  /** The versions it recorded are the App's, so the worker would open it. */
  restorable: boolean;
}>;

/** Reads the newest finished backup beside `dataDir`, or null when there is none. */
export async function readLedgerCleanupBackup(dataDir: string, current: LedgerBackupVersions): Promise<LedgerCleanupBackup | null> {
  const [newest] = await listLedgerBackups(dataDir);
  if (!newest) return null;
  const versions = await readLedgerBackupVersions(newest.path);
  return {
    path: newest.path,
    bytes: await directoryBytes(newest.path).catch(() => null),
    takenAt: newest.takenAt.toISOString(),
    expiresAt: ledgerBackupExpiresAt(newest.takenAt).toISOString(),
    restorable: versions !== null && versions.canonical === current.canonical && versions.operational === current.operational,
  };
}

/** The versions a backup recorded; null when it recorded none, as one taken before ADR 0156, or the file is unreadable. */
export async function readLedgerBackupVersions(backup: string): Promise<LedgerBackupVersions | null> {
  return parseLedgerBackupVersions(await readFile(`${backup}${VERSIONS_SUFFIX}`, "utf8").catch(() => null));
}

/** The versions a backup's versions file holds; null for no file or one that does not hold both. */
export function parseLedgerBackupVersions(text: string | null): LedgerBackupVersions | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<LedgerBackupVersions> | null;
    const version = (field: unknown) => typeof field === "number" && Number.isSafeInteger(field);
    return value && version(value.canonical) && version(value.operational) ? { canonical: value.canonical!, operational: value.operational! } : null;
  } catch {
    return null;
  }
}

/** Kills the process the pid file beside `partial` names, if it is still the one copying into `partial`. */
async function stopCopyInto(partial: string): Promise<void> {
  const pid = Number.parseInt(await readFile(`${partial}${PID_SUFFIX}`, "utf8").catch(() => ""), 10);
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  // The pid may have gone to another process since: only a clone copying into this partial is killed. A UTF-8
  // locale keeps `ps` from escaping a non-ASCII path, which an App opened from Finder may otherwise get.
  const args = await run("/bin/ps", ["-ww", "-o", "args=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "en_US.UTF-8" } })
    .then(({ stdout }) => stdout.trim(), () => "");
  if (!args.includes(" -cR ") || !args.endsWith(` ${partial}`)) return;
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
  /** Written beside the backup before it gets its name; the worker passes the open store's. */
  versions?: LedgerBackupVersions;
  /** Free bytes the run needs after the backup, on top of the backup's own (`cleanupBackupBytesNeeded`). */
  reserveBytes?: number;
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

export async function ledgerBackupRoom(dataDir: string, freeBytes: () => Promise<number>, reserveBytes = 0): Promise<LedgerBackupRoom> {
  const [storeBytes, free] = await Promise.all([directoryBytes(dataDir), freeBytes()]);
  return { storeBytes, neededBytes: cleanupBackupBytesNeeded(storeBytes, reserveBytes), freeBytes: free };
}

/**
 * Copies `dataDir` beside itself while `store` writes nothing, flushes the
 * copy to the disk, then gives it its name. Refuses when the disk has less
 * free than `ledgerBackupBytesNeeded`. A copy that fails or is aborted is
 * removed. Once the new backup is whole, every earlier one is removed. Returns
 * where the copy went, which stays on the host: the renderer is never told a
 * path.
 */
export async function backUpLedger(store: PGliteStore, dataDir: string, options: LedgerBackupOptions): Promise<string> {
  const { signal } = options;
  dataDir = resolve(dataDir);
  await removePartialLedgerBackups(dataDir);
  const room = await ledgerBackupRoom(dataDir, options.freeBytes, options.reserveBytes);
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
    if (options.versions) await writeFile(`${target}${VERSIONS_SUFFIX}`, JSON.stringify(options.versions));
    await rename(partial, target);
    named = true;
    await (options.flushEntry ?? fsyncPath)(dirname(target));
  } catch (error) {
    // A name that may not survive a crash is no backup: it goes back to `.partial` and is removed with the copy.
    if (named) await rename(target, partial).catch(() => rm(target, { recursive: true, force: true }));
    await rm(partial, { recursive: true, force: true });
    await rm(`${target}${VERSIONS_SUFFIX}`, { force: true });
    if (signal?.aborted) throw error;
    throw new LedgerBackupError("copy-failed", error instanceof Error ? error.message : String(error));
  }
  // The new backup is whole, so the earlier one goes. One that cannot be removed now expires on its own.
  await removeOtherLedgerBackups(dataDir, target).catch(() => undefined);
  return target;
}
