import { existsSync } from "node:fs";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  ledgerBackupTakenAt,
  ledgerBackupVersionsPath,
  ledgerRestorePendingPath,
  parseLedgerBackupVersions,
  type LedgerBackupVersions,
} from "../src/ledger/pglite/data-dir-backup.ts";

/**
 * The Cleanup Restore of ADR 0157: the backup takes the ledger's place at
 * launch, in the main process, before the worker opens the folder.
 *
 * A request writes `<ledger>.restore-pending`. The launch step reads it and
 * the folders that exist, so a crash between any two of its steps is
 * finished or undone at the next launch:
 *
 * - `requested`: the ledger goes to the file's `aside` name, the backup to
 *   the ledger's, the ledger's clean-shutdown record is removed, and the file
 *   says `swapped`.
 * - `swapped`: the worker opens the backup, checking every index (ADR 0147).
 *   Ready writes the outcome and `opened`; a failure writes `swap-back`.
 * - `opened`: the replaced ledger, the backup's versions file and the
 *   pending file are removed.
 * - `swap-back`: the folders are renamed back, and the outcome says the
 *   restore failed.
 *
 * Nothing else is renamed or removed: only the ledger folder, the backup the
 * file names, its versions file, the `aside` folder this restore made, the
 * clean-shutdown record and these two files. The file holds bare names, each
 * checked against the form it must have, so it cannot name anything else.
 */

/** Where a restore started: Settings can go back to the ledger it replaced; the unusable-ledger dialog cannot (ADR 0150). */
export type LedgerRestoreOrigin = "settings" | "unusable";

type RestoreState = "requested" | "swapped" | "opened" | "swap-back";

type PendingRestore = Readonly<{
  from: LedgerRestoreOrigin;
  /** The backup's bare name, beside the ledger. */
  backup: string;
  /** Where the ledger goes, a bare name beside it: `.replaced-` from Settings, `.damaged-` from the dialog. */
  aside: string;
  state: RestoreState;
  /** Launches that have opened the backup in the ledger's place. */
  opens: number;
}>;

/** How the last restore ended, kept for Settings to say once. */
export type LedgerRestoreOutcome =
  | Readonly<{ status: "restored"; takenAt: string }>
  | Readonly<{ status: "failed" }>;

/** The filesystem calls a restore makes; checks replace them to crash between any two. */
export type LedgerRestoreFs = Readonly<{
  /** The file's text, or null when nothing is there. */
  readText(path: string): Promise<string | null>;
  /** Writes under a temporary name, flushes, renames into place and flushes the folder. */
  writeFlushed(path: string, text: string): Promise<void>;
  /** Renames, then flushes the folder that holds the new name. */
  rename(from: string, to: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  removeFolder(path: string): Promise<void>;
  /** `folder` for a directory that is not a link, `other` for anything else, null for nothing. */
  kind(path: string): Promise<"folder" | "other" | null>;
}>;

async function flushFolder(folder: string): Promise<void> {
  const handle = await open(folder, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

export const NODE_RESTORE_FS: LedgerRestoreFs = {
  readText: (path) => readFile(path, "utf8").catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  }),
  async writeFlushed(path, text) {
    const temporary = `${path}.tmp`;
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await flushFolder(dirname(path));
  },
  async rename(from, to) {
    await rename(from, to);
    await flushFolder(dirname(to));
  },
  removeFile: (path) => rm(path, { force: true }),
  removeFolder: (path) => rm(path, { recursive: true, force: true }),
  kind: (path) => lstat(path).then(
    (entry) => (entry.isDirectory() ? "folder" as const : "other" as const),
    (error: unknown) => {
      if (missing(error)) return null;
      throw error;
    },
  ),
};

/** A restore that could not be asked for; nothing was written. */
export class LedgerRestoreRefused extends Error {
  override readonly name = "LedgerRestoreRefused";
}

/** Launches that may open the backup before the restore gives up on it: one more after a crash mid-open. */
const MAX_OPENS = 2;

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(?:-\d+)?$/u;

/** The clean-shutdown record the worker writes beside the folder it closed (ADR 0147). */
function cleanShutdownRecord(dataDir: string): string {
  return `${dataDir}.clean-shutdown`;
}

function outcomePath(dataDir: string): string {
  return `${dataDir}.restore-outcome`;
}

function asideInfix(from: LedgerRestoreOrigin): string {
  return from === "settings" ? ".replaced-" : ".damaged-";
}

function isAsideName(dataDir: string, from: LedgerRestoreOrigin, name: string): boolean {
  const prefix = `${basename(dataDir)}${asideInfix(from)}`;
  return name.startsWith(prefix) && STAMP.test(name.slice(prefix.length));
}

/** Where Settings puts the ledger a restore replaces: beside it, named by the time, never over another folder. */
export function replacedLedgerPath(dataDir: string, now: Date, exists: (path: string) => boolean = existsSync): string {
  dataDir = resolve(dataDir);
  const stamp = now.toISOString().replaceAll(":", "-").replace(/\.\d+Z$/u, "Z");
  for (let attempt = 0; ; attempt += 1) {
    const candidate = `${dataDir}.replaced-${stamp}${attempt === 0 ? "" : `-${attempt}`}`;
    if (!exists(candidate)) return candidate;
  }
}

function parsePending(dataDir: string, text: string): PendingRestore | null {
  let value: Partial<Record<keyof PendingRestore, unknown>> | null;
  try {
    value = JSON.parse(text) as typeof value;
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const { from, backup, aside, state, opens } = value;
  if (from !== "settings" && from !== "unusable") return null;
  if (typeof backup !== "string" || !ledgerBackupTakenAt(dataDir, backup)) return null;
  if (typeof aside !== "string" || !isAsideName(dataDir, from, aside)) return null;
  if (state !== "requested" && state !== "swapped" && state !== "opened" && state !== "swap-back") return null;
  if (state === "swap-back" && from !== "settings") return null;
  if (typeof opens !== "number" || !Number.isSafeInteger(opens) || opens < 0) return null;
  return { from, backup, aside, state, opens };
}

function sameVersions(a: LedgerBackupVersions | null, b: LedgerBackupVersions): boolean {
  return a !== null && a.canonical === b.canonical && a.operational === b.operational;
}

export type LedgerRestoreRequest = Readonly<{
  from: LedgerRestoreOrigin;
  /** The App's versions: a backup that recorded others cannot be opened. */
  current: LedgerBackupVersions;
  /** From the unusable-ledger dialog: the `.damaged-` path it named. Settings picks a `.replaced-` one. */
  aside?: string;
  now?: () => Date;
  fs?: LedgerRestoreFs;
}>;

/**
 * Records that `backup` should take the ledger's place at the next launch,
 * and flushes the record. Refuses a backup that is not a finished one beside
 * the ledger whose versions are the App's, and a second request.
 */
export async function requestLedgerRestore(dataDir: string, backup: string, request: LedgerRestoreRequest): Promise<void> {
  dataDir = resolve(dataDir);
  const fs = request.fs ?? NODE_RESTORE_FS;
  backup = resolve(backup);
  const name = basename(backup);
  if (dirname(backup) !== dirname(dataDir) || !ledgerBackupTakenAt(dataDir, name)) {
    throw new LedgerRestoreRefused("Only a Cleanup Backup beside the ledger can be restored.");
  }
  if (await fs.kind(backup) !== "folder") throw new LedgerRestoreRefused("The backup is gone.");
  if (!sameVersions(parseLedgerBackupVersions(await fs.readText(ledgerBackupVersionsPath(backup))), request.current)) {
    throw new LedgerRestoreRefused("The backup can no longer be restored.");
  }
  if (await fs.kind(ledgerRestorePendingPath(dataDir)) !== null) throw new LedgerRestoreRefused("A restore is already under way.");
  const aside = request.aside === undefined
    ? replacedLedgerPath(dataDir, (request.now ?? (() => new Date()))())
    : resolve(request.aside);
  if (dirname(aside) !== dirname(dataDir) || !isAsideName(dataDir, request.from, basename(aside)) || await fs.kind(aside) !== null) {
    throw new LedgerRestoreRefused("The ledger has nowhere to go aside.");
  }
  const pending: PendingRestore = { from: request.from, backup: name, aside: basename(aside), state: "requested", opens: 0 };
  await fs.writeFlushed(ledgerRestorePendingPath(dataDir), JSON.stringify(pending));
}

/** Whether a restore has been asked for and has not ended. */
export async function ledgerRestoreRequested(dataDir: string, fs: LedgerRestoreFs = NODE_RESTORE_FS): Promise<boolean> {
  return await fs.kind(ledgerRestorePendingPath(resolve(dataDir))) !== null;
}

/**
 * How the last restore ended, once: the record is removed as it is read, so
 * Settings says it a single time. Null when there is none to say.
 */
export async function takeLedgerRestoreOutcome(dataDir: string, fs: LedgerRestoreFs = NODE_RESTORE_FS): Promise<LedgerRestoreOutcome | null> {
  const path = outcomePath(resolve(dataDir));
  const text = await fs.readText(path);
  if (text === null) return null;
  await fs.removeFile(path);
  try {
    const value = JSON.parse(text) as Partial<{ status: unknown; takenAt: unknown }> | null;
    if (value?.status === "failed") return { status: "failed" };
    if (value?.status === "restored" && typeof value.takenAt === "string" && !Number.isNaN(Date.parse(value.takenAt))) {
      return { status: "restored", takenAt: new Date(value.takenAt).toISOString() };
    }
  } catch {
    // Not one this App wrote; nothing to say.
  }
  return null;
}

/** What the launch step left for the worker's open to decide. */
export type LedgerRestoreLaunch =
  | Readonly<{ kind: "none" }>
  | Readonly<{
    kind: "opening";
    /** True from Settings: a failed open goes back to the replaced ledger. */
    canSwapBack: boolean;
    /** The worker opened the backup: the restore is done. */
    opened(): Promise<void>;
    /**
     * The worker could not open it. From Settings, records the swap back,
     * which the next launch makes; the caller starts the App again. From the
     * unusable-ledger dialog there is nothing to go back to, so the restore
     * just ends and the open's failure is handled as any other.
     */
    failed(): Promise<void>;
  }>;

const NONE: LedgerRestoreLaunch = Object.freeze({ kind: "none" });

export type LedgerRestoreLaunchDeps = Readonly<{
  current: LedgerBackupVersions;
  fs?: LedgerRestoreFs;
  /** Codes only: a path or an error message stays out of the log. */
  log?: (code: string) => void;
}>;

/**
 * The launch step, run before the worker starts. Carries out a requested
 * restore, finishes or undoes one a crash cut short, and says whether the
 * coming open decides one. It is idempotent: run again after a crash at any
 * point, it continues from the folders it finds.
 *
 * It throws only when it could neither carry out a step nor put the ledger
 * back; the App must then not open the ledger folder, which may be missing.
 */
export async function resumeLedgerRestore(dataDir: string, deps: LedgerRestoreLaunchDeps): Promise<LedgerRestoreLaunch> {
  dataDir = resolve(dataDir);
  const fs = deps.fs ?? NODE_RESTORE_FS;
  const log = deps.log ?? (() => {});
  const pendingPath = ledgerRestorePendingPath(dataDir);
  const text = await fs.readText(pendingPath);
  if (text === null) return NONE;
  await fs.removeFile(`${pendingPath}.tmp`);
  const pending = parsePending(dataDir, text);
  if (!pending) {
    // Nothing it names can be trusted, so nothing is moved.
    log("ledger-restore-unreadable");
    await writeOutcome({ status: "failed" });
    await fs.removeFile(pendingPath);
    return NONE;
  }
  const folder = dirname(dataDir);
  const backup = join(folder, pending.backup);
  const aside = join(folder, pending.aside);
  const takenAt = ledgerBackupTakenAt(dataDir, pending.backup)!.toISOString();

  async function writeOutcome(outcome: LedgerRestoreOutcome) {
    await fs.writeFlushed(outcomePath(dataDir), JSON.stringify(outcome));
  }
  async function write(next: PendingRestore) {
    await fs.writeFlushed(pendingPath, JSON.stringify(next));
  }
  /** Ends a restore that changed nothing, or that was put back. */
  async function refuse(code: string) {
    log(code);
    await writeOutcome({ status: "failed" });
    await fs.removeFile(pendingPath);
    return NONE;
  }
  async function restorable() {
    return await fs.kind(backup) === "folder"
      && sameVersions(parseLedgerBackupVersions(await fs.readText(ledgerBackupVersionsPath(backup))), deps.current);
  }
  /** The restore is done: what it replaced and what named the backup go. A `.damaged-` ledger stays, as a rebuild leaves it. */
  async function finish() {
    if (pending!.from === "settings" && await fs.kind(aside) === "folder") await fs.removeFolder(aside);
    await fs.removeFile(ledgerBackupVersionsPath(backup));
    await fs.removeFile(pendingPath);
  }
  /** The backup, used in the ledger's place, could not open, and the dialog's restore has nothing to go back to. */
  async function abandon() {
    await fs.removeFile(ledgerBackupVersionsPath(backup));
    await fs.removeFile(pendingPath);
  }
  /** Renames the folders back: the backup to its name, the replaced ledger to the ledger's. */
  async function swapBack() {
    if (await fs.kind(aside) === "folder") {
      if (await fs.kind(dataDir) === "folder" && await fs.kind(backup) === null) await fs.rename(dataDir, backup);
      if (await fs.kind(dataDir) === null) await fs.rename(aside, dataDir);
    }
    if (await fs.kind(aside) !== null) log("ledger-restore-swap-back-incomplete");
    return refuse("ledger-restore-swapped-back");
  }
  function opening(state: PendingRestore): LedgerRestoreLaunch {
    return {
      kind: "opening",
      canSwapBack: state.from === "settings",
      async opened() {
        await writeOutcome({ status: "restored", takenAt });
        await write({ ...state, state: "opened" });
        await finish();
      },
      async failed() {
        if (state.from === "settings") await write({ ...state, state: "swap-back" });
        else await abandon();
      },
    };
  }

  switch (pending.state) {
    case "opened":
      await finish();
      return NONE;
    case "swap-back":
      return swapBack();
    case "swapped": {
      if (pending.opens >= MAX_OPENS || await fs.kind(dataDir) !== "folder") {
        if (pending.from === "settings") return swapBack();
        log("ledger-restore-abandoned");
        await abandon();
        return NONE;
      }
      const next = { ...pending, opens: pending.opens + 1 };
      await fs.removeFile(cleanShutdownRecord(dataDir));
      await write(next);
      return opening(next);
    }
    case "requested": {
      try {
        const ledger = await fs.kind(dataDir);
        const asideKind = await fs.kind(aside);
        if (ledger === "folder" && asideKind === null) {
          if (!(await restorable())) return refuse("ledger-restore-not-restorable");
          await fs.rename(dataDir, aside);
        } else if (!(ledger === null || (ledger === "folder" && asideKind === "folder" && await fs.kind(backup) === null))) {
          // Not a state any step of this restore leaves: nothing is moved.
          return refuse("ledger-restore-inconsistent");
        }
        if (await fs.kind(dataDir) === null) {
          if (!(await restorable())) {
            if (await fs.kind(aside) === "folder") await fs.rename(aside, dataDir);
            return refuse("ledger-restore-not-restorable");
          }
          await fs.rename(backup, dataDir);
        }
      } catch (error) {
        // The ledger goes back where it was before the error is reported; if even that fails, the App must not open it.
        try {
          if (await fs.kind(dataDir) === null && await fs.kind(aside) === "folder") await fs.rename(aside, dataDir);
        } catch {
          throw error;
        }
        if (await fs.kind(dataDir) !== "folder") throw error;
        return refuse("ledger-restore-rename-failed");
      }
      // The backup is a copy of a running store, so its open checks every index (ADR 0147).
      await fs.removeFile(cleanShutdownRecord(dataDir));
      const next: PendingRestore = { ...pending, state: "swapped", opens: 1 };
      await write(next);
      return opening(next);
    }
  }
}
