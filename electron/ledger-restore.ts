import { existsSync } from "node:fs";
import { lstat, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  isReplacedLedgerName,
  ledgerBackupTakenAt,
  ledgerBackupVersionsPath,
  ledgerRestoreOpenedPath,
  ledgerRestoreOutcomePath,
  ledgerRestorePendingPath,
  ledgerRestoreUnreadablePath,
  parseLedgerBackupVersions,
  type LedgerBackupVersions,
} from "../src/ledger/pglite/data-dir-backup.ts";

/**
 * The Cleanup Restore of ADR 0157: the backup takes the ledger's place at
 * launch, in the main process, before the worker opens the folder.
 *
 * A request writes `<ledger>.restore-pending`. The launch step reads it and
 * the folders that exist, so a crash or an error between or inside any two
 * of its steps is finished or undone at the next launch:
 *
 * - `requested`: the ledger goes to the file's `aside` name, the backup to
 *   the ledger's, the clean-shutdown record goes, and the file says
 *   `swapped`. After any error the folders decide: a ledger folder with the
 *   backup's name free is a finished swap; anything else is moved back.
 * - `swapped`: the worker opens the backup, checking every index (ADR
 *   0147). Ready renames the file to `<ledger>.restore-opened`, a signal that
 *   needs no free space; a clean close of the restored store, which writes
 *   the clean-shutdown record, is a second one. A failed open that the App
 *   saw writes `swap-back`. Only that recorded failure swaps back: an App
 *   that died with no signal either way opens the backup again, so a ledger
 *   in use is never swapped out on a guess; after `STUCK_OPENS` such
 *   launches the person is asked before the worker starts.
 * - opened: the replaced ledger, the backup's versions file and the opened
 *   file are removed, each retried at later launches until it goes.
 * - `swap-back`: the folders are renamed back, the clean-shutdown record
 *   goes, and the outcome says the restore failed. Once the folders are
 *   back, a later launch only retries removing the file.
 *
 * A `.replaced-` folder exists for a reason only while a readable pending or
 * opened file names it, so the launch removes any other: one whose removal
 * was cut short after its file went.
 *
 * Nothing else is renamed or removed: only the ledger folder, the backup the
 * file names, its versions file, the `aside` folder this restore made, the
 * clean-shutdown record and the restore's own files. The file holds bare
 * names, each checked against the form it must have, so it cannot name
 * anything else.
 */

/** Where a restore started: Settings can go back to the ledger it replaced; the unusable-ledger dialog cannot (ADR 0150). */
export type LedgerRestoreOrigin = "settings" | "unusable";

type RestoreState = "requested" | "swapped" | "swap-back";

type PendingRestore = Readonly<{
  from: LedgerRestoreOrigin;
  /** The backup's bare name, beside the ledger. */
  backup: string;
  /** Where the ledger goes, a bare name beside it: `.replaced-` from Settings, `.damaged-` from the dialog. */
  aside: string;
  state: RestoreState;
  /**
   * Launches that began opening the backup, counted before the worker starts;
   * a count that could not be written does not count. Never a reason to swap
   * back by itself: after `STUCK_OPENS`, the person is asked.
   */
  opens: number;
  /** When the restore was asked for: only a fresh request is carried out. */
  requestedAt: string;
  /** The App version that asked, for diagnosis only: an update applied by the restart does not refuse the restore. */
  appVersion: string;
}>;

/** How the last restore ended, kept for Settings to say once. `backup` names one that opened and failed, for the host only. */
export type LedgerRestoreOutcome =
  | Readonly<{ status: "restored"; takenAt: string }>
  | Readonly<{ status: "failed"; backup?: string }>;

/** The filesystem calls a restore makes; checks replace them to fail before or after any change. */
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
  /** The names in a folder. */
  list(folder: string): Promise<string[]>;
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
  list: (folder) => readdir(folder),
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

/** Launches that began opening the backup with no word from any of them, after which the person decides. */
export const STUCK_OPENS = 2;
/** The App restarts as soon as a restore is asked for; an older request is not carried out. */
export const LEDGER_RESTORE_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
/** Clock skew a request's time may show ahead of the launch's. */
const REQUEST_SKEW_MS = 5 * 60 * 1000;

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(?:-\d+)?$/u;

/** The clean-shutdown record the worker writes beside the folder it closed (ADR 0147). */
function cleanShutdownRecord(dataDir: string): string {
  return `${dataDir}.clean-shutdown`;
}

function isAsideName(dataDir: string, from: LedgerRestoreOrigin, name: string): boolean {
  if (from === "settings") return isReplacedLedgerName(dataDir, name);
  const prefix = `${basename(dataDir)}.damaged-`;
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
  const { from, backup, aside, state, opens, requestedAt, appVersion } = value;
  if (from !== "settings" && from !== "unusable") return null;
  if (typeof backup !== "string" || !ledgerBackupTakenAt(dataDir, backup)) return null;
  if (typeof aside !== "string" || !isAsideName(dataDir, from, aside)) return null;
  if (state !== "requested" && state !== "swapped" && state !== "swap-back") return null;
  if (typeof opens !== "number" || !Number.isSafeInteger(opens) || opens < 0) return null;
  if (typeof requestedAt !== "string" || Number.isNaN(Date.parse(requestedAt))) return null;
  return { from, backup, aside, state, opens, requestedAt, appVersion: typeof appVersion === "string" ? appVersion : "" };
}

function sameVersions(a: LedgerBackupVersions | null, b: LedgerBackupVersions): boolean {
  return a !== null && a.canonical === b.canonical && a.operational === b.operational;
}

const codeOf = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : "unknown";
};

export type LedgerRestoreRequest = Readonly<{
  from: LedgerRestoreOrigin;
  /** The App's versions: a backup that recorded others cannot be opened. */
  current: LedgerBackupVersions;
  appVersion: string;
  /** From the unusable-ledger dialog: the `.damaged-` path it named. Settings picks a `.replaced-` one. */
  aside?: string;
  /** Replaces a request that has not been carried out yet; the dialog's restore replaces one from Settings. */
  replace?: boolean;
  now?: () => Date;
  fs?: LedgerRestoreFs;
}>;

/**
 * Records that `backup` should take the ledger's place at the next launch,
 * and flushes the record. Refuses a backup that is not a finished store
 * beside the ledger whose versions are the App's, and a second request
 * unless it replaces one not yet carried out.
 */
export async function requestLedgerRestore(dataDir: string, backup: string, request: LedgerRestoreRequest): Promise<void> {
  dataDir = resolve(dataDir);
  const fs = request.fs ?? NODE_RESTORE_FS;
  const now = (request.now ?? (() => new Date()))();
  backup = resolve(backup);
  const name = basename(backup);
  if (dirname(backup) !== dirname(dataDir) || !ledgerBackupTakenAt(dataDir, name)) {
    throw new LedgerRestoreRefused("Only a Cleanup Backup beside the ledger can be restored.");
  }
  if (!(await holdsStore(fs, backup))) throw new LedgerRestoreRefused("The backup is gone.");
  if (!sameVersions(parseLedgerBackupVersions(await fs.readText(ledgerBackupVersionsPath(backup))), request.current)) {
    throw new LedgerRestoreRefused("The backup can no longer be restored.");
  }
  const existing = await fs.readText(ledgerRestorePendingPath(dataDir));
  if (existing !== null && !(request.replace && parsePending(dataDir, existing)?.state === "requested")) {
    throw new LedgerRestoreRefused("A restore is already under way.");
  }
  const aside = request.aside === undefined ? replacedLedgerPath(dataDir, now) : resolve(request.aside);
  if (dirname(aside) !== dirname(dataDir) || !isAsideName(dataDir, request.from, basename(aside)) || await fs.kind(aside) !== null) {
    throw new LedgerRestoreRefused("The ledger has nowhere to go aside.");
  }
  const pending: PendingRestore = {
    from: request.from,
    backup: name,
    aside: basename(aside),
    state: "requested",
    opens: 0,
    requestedAt: now.toISOString(),
    appVersion: request.appVersion,
  };
  await fs.writeFlushed(ledgerRestorePendingPath(dataDir), JSON.stringify(pending));
}

/** A folder that holds a store: an emptied one would open as a new, empty ledger. */
async function holdsStore(fs: LedgerRestoreFs, folder: string): Promise<boolean> {
  return await fs.kind(folder) === "folder" && await fs.kind(join(folder, "PG_VERSION")) === "other";
}

/** Whether a restore has been asked for and not carried out yet: Settings refuses a cleanup, reset or deletion meanwhile. */
export async function ledgerRestoreRequested(dataDir: string, fs: LedgerRestoreFs = NODE_RESTORE_FS): Promise<boolean> {
  dataDir = resolve(dataDir);
  const text = await fs.readText(ledgerRestorePendingPath(dataDir));
  if (text === null) return false;
  // A file that cannot be read may still be one; the next launch settles it.
  const pending = parsePending(dataDir, text);
  return pending === null || pending.state === "requested";
}

function parseOutcome(text: string | null): LedgerRestoreOutcome | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<{ status: unknown; takenAt: unknown; backup: unknown }> | null;
    if (value?.status === "failed") return typeof value.backup === "string" ? { status: "failed", backup: value.backup } : { status: "failed" };
    if (value?.status === "restored" && typeof value.takenAt === "string" && !Number.isNaN(Date.parse(value.takenAt))) {
      return { status: "restored", takenAt: new Date(value.takenAt).toISOString() };
    }
  } catch {
    // Not one this App wrote; nothing to say.
  }
  return null;
}

/**
 * How the last restore ended, once: the record is removed as it is read, so
 * Settings says it a single time. Null when there is none to say. No name
 * or path leaves the host.
 */
export async function takeLedgerRestoreOutcome(
  dataDir: string,
  fs: LedgerRestoreFs = NODE_RESTORE_FS,
): Promise<Readonly<{ status: "restored"; takenAt: string }> | Readonly<{ status: "failed" }> | null> {
  const path = ledgerRestoreOutcomePath(dataDir);
  const outcome = parseOutcome(await fs.readText(path));
  await fs.removeFile(path);
  if (outcome?.status === "failed") return { status: "failed" };
  return outcome;
}

/**
 * For the unusable-ledger dialog: the backup a swap back just gave back,
 * which opened and failed, so it is not offered again. The dialog takes the
 * outcome as Settings would, since Settings cannot open while the ledger is
 * unusable; a backup is hidden only by the swap back that read it here.
 * A restore refused before the backup opened names no backup.
 */
export async function takeFailedRestoreBackup(dataDir: string, fs: LedgerRestoreFs = NODE_RESTORE_FS): Promise<string | null> {
  dataDir = resolve(dataDir);
  const path = ledgerRestoreOutcomePath(dataDir);
  const outcome = parseOutcome(await fs.readText(path).catch(() => null));
  if (outcome?.status !== "failed" || !outcome.backup || !ledgerBackupTakenAt(dataDir, outcome.backup)) return null;
  // Only this outcome is the dialog's to take; any other waits for Settings.
  await fs.removeFile(path).catch(() => undefined);
  return join(dirname(dataDir), outcome.backup);
}

/** What the launch step left for the worker's open to decide. */
export type LedgerRestoreLaunch =
  | Readonly<{ kind: "none" }>
  /** The person chose to quit while a restored backup would not open: nothing starts. */
  | Readonly<{ kind: "quit" }>
  | Readonly<{
    kind: "opening";
    /** True from Settings: a failed open goes back to the replaced ledger. */
    canSwapBack: boolean;
    /** The worker opened the backup: the restore is done. It never throws; what it could not finish, a later launch does. */
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

/** What the person chose for a restored backup that has not finished opening after `STUCK_OPENS` launches. */
export type StuckRestoreChoice = "retry" | "swap-back" | "quit";

export type LedgerRestoreLaunchDeps = Readonly<{
  current: LedgerBackupVersions;
  now?: () => Date;
  fs?: LedgerRestoreFs;
  /**
   * Asks the person what to do with a restored backup that `STUCK_OPENS`
   * launches began opening with no word from any of them. Without it, the
   * backup opens again.
   */
  askStuck?: (backup: Readonly<{ takenAt: Date; from: LedgerRestoreOrigin }>) => Promise<StuckRestoreChoice>;
  /** Codes only: a path or an error message stays out of the log. */
  log?: (code: string, detail?: string) => void;
}>;

/**
 * The launch step, run before the worker starts. Carries out a requested
 * restore, finishes or undoes one a crash or an error cut short, and says
 * whether the coming open decides one. It is idempotent: run again after a
 * failure at any point, it continues from the folders it finds.
 *
 * It throws only when the folders are not in a state the App may open: the
 * ledger folder may be missing, or still hold a backup with a stale
 * clean-shutdown record.
 */
export async function resumeLedgerRestore(dataDir: string, deps: LedgerRestoreLaunchDeps): Promise<LedgerRestoreLaunch> {
  dataDir = resolve(dataDir);
  const fs = deps.fs ?? NODE_RESTORE_FS;
  const log = deps.log ?? (() => {});
  const now = (deps.now ?? (() => new Date()))();
  const folder = dirname(dataDir);
  const pendingPath = ledgerRestorePendingPath(dataDir);
  const openedPath = ledgerRestoreOpenedPath(dataDir);
  const outcomePath = ledgerRestoreOutcomePath(dataDir);
  const record = cleanShutdownRecord(dataDir);
  const unreadablePath = ledgerRestoreUnreadablePath(dataDir);

  /** Runs a step whose failure must not stop the App from starting; a later launch tries again. */
  async function tryTo(code: string, step: () => Promise<unknown>): Promise<boolean> {
    try {
      await step();
      return true;
    } catch (error) {
      log(code, codeOf(error));
      return false;
    }
  }
  const writeOutcome = (outcome: LedgerRestoreOutcome) =>
    tryTo("ledger-restore-outcome-failed", () => fs.writeFlushed(outcomePath, JSON.stringify(outcome)));
  /** The record must be gone before a backup opens, or its open would skip the index check. */
  async function dropRecord() {
    await fs.removeFile(record).catch(() => undefined);
    if (await fs.kind(record) !== null) await fs.removeFile(record);
  }
  /** Removes what an opened restore leaves; anything that will not go now goes at a later launch, which the opened file asks for. */
  async function finishOpened(state: PendingRestore | null) {
    await tryTo("ledger-restore-finish-failed", async () => {
      let done = true;
      if (state) {
        const aside = join(folder, state.aside);
        if (state.from === "settings" && await fs.kind(aside) !== null) {
          await tryTo("ledger-restore-replaced-removal-failed", () => fs.removeFolder(aside));
          done &&= await fs.kind(aside) === null;
        }
        const sidecar = ledgerBackupVersionsPath(join(folder, state.backup));
        await tryTo("ledger-restore-sidecar-removal-failed", () => fs.removeFile(sidecar));
        done &&= await fs.kind(sidecar) === null;
      }
      if (done) await fs.removeFile(openedPath);
    });
  }
  /** Keeps a restore file that cannot be read under its own name, never deletes it: it may name the person's ledger. */
  async function keepUnreadable(path: string) {
    log("ledger-restore-unreadable");
    await tryTo("ledger-restore-unreadable-rename-failed", () => fs.rename(path, unreadablePath));
  }
  /** Finishes an earlier opened restore; true when its file is gone, so the name is free. */
  async function finishEarlierOpened(): Promise<boolean> {
    let text: string | null = null;
    await tryTo("ledger-restore-opened-read-failed", async () => { text = await fs.readText(openedPath); });
    if (text !== null) {
      const state = parsePending(dataDir, text);
      if (state) await finishOpened(state);
      else await keepUnreadable(openedPath);
    }
    let gone = false;
    await tryTo("ledger-restore-opened-read-failed", async () => { gone = await fs.kind(openedPath) === null; });
    return gone;
  }
  /**
   * Removes `.replaced-` folders no readable restore file names, and versions
   * files whose backup is gone. Such a folder is a ledger a finished restore
   * replaced: a restore makes it with its file in place, and only that file
   * can send it back, so once no file names it nothing will. When a file
   * exists that cannot be read, nothing is removed.
   */
  async function removeUnnamedLeftovers() {
    await tryTo("ledger-restore-leftover-removal-failed", async () => {
      // A kept unreadable file may have named any of them: nothing goes until a Canonical Reset.
      if (await fs.kind(unreadablePath) !== null) return;
      const named = new Set<string>();
      for (const path of [pendingPath, openedPath]) {
        const text = await fs.readText(path);
        if (text === null) continue;
        const state = parsePending(dataDir, text);
        if (!state) return;
        named.add(state.aside);
        named.add(state.backup);
      }
      for (const name of await fs.list(folder)) {
        if (isReplacedLedgerName(dataDir, name) && !named.has(name)) {
          await tryTo("ledger-restore-leftover-removal-failed", () => fs.removeFolder(join(folder, name)));
        } else if (name.endsWith(".versions.json")) {
          const backupName = name.slice(0, -".versions.json".length);
          if (ledgerBackupTakenAt(dataDir, backupName) && !named.has(backupName) && await fs.kind(join(folder, backupName)) === null) {
            await tryTo("ledger-restore-leftover-removal-failed", () => fs.removeFile(join(folder, name)));
          }
        }
      }
    });
  }

  await tryTo("ledger-restore-cleanup-failed", () => fs.removeFile(`${pendingPath}.tmp`));
  await tryTo("ledger-restore-cleanup-failed", () => fs.removeFile(`${outcomePath}.tmp`));
  await tryTo("ledger-restore-cleanup-failed", () => fs.removeFile(`${openedPath}.tmp`));

  // A restore that opened, whose leftovers did not all go, then any whose file went first.
  await finishEarlierOpened();
  await removeUnnamedLeftovers();

  const text = await fs.readText(pendingPath);
  if (text === null) return NONE;
  const pending = parsePending(dataDir, text);
  if (!pending) {
    // Nothing it names can be trusted, so nothing it may name is moved or removed; the file itself is kept.
    await keepUnreadable(pendingPath);
    await writeOutcome({ status: "failed" });
    if (await fs.kind(dataDir) === null) {
      // The App must not start on an empty folder: a single set-aside ledger can only be the one that was here.
      const replaced = (await fs.list(folder)).filter((name) => isReplacedLedgerName(dataDir, name));
      if (replaced.length > 1) throw new Error("ledger-restore-ledger-missing");
      if (replaced.length === 1) {
        await fs.rename(join(folder, replaced[0]!), dataDir);
        await dropRecord();
      }
    }
    return NONE;
  }
  const backup = join(folder, pending.backup);
  const aside = join(folder, pending.aside);
  const takenAt = ledgerBackupTakenAt(dataDir, pending.backup)!.toISOString();
  const sidecar = ledgerBackupVersionsPath(backup);

  const write = (next: PendingRestore) => fs.writeFlushed(pendingPath, JSON.stringify(next));
  /** Ends a restore that left the ledger as it was; `opened` when the backup opened and failed. */
  async function refuse(code: string, opened = false) {
    log(code);
    await writeOutcome(opened ? { status: "failed", backup: pending!.backup } : { status: "failed" });
    await tryTo("ledger-restore-pending-removal-failed", () => fs.removeFile(pendingPath));
    return NONE;
  }
  async function restorable() {
    return await holdsStore(fs, backup) && sameVersions(parseLedgerBackupVersions(await fs.readText(sidecar)), deps.current);
  }
  /** The backup sits in the ledger's place: its name is free and a folder is there. */
  async function swapped() {
    return await fs.kind(dataDir) === "folder" && await fs.kind(backup) === null;
  }
  /** Renames the folders back: the backup to its name, the replaced ledger to the ledger's. */
  async function moveBack() {
    if (await fs.kind(aside) !== "folder") return;
    if (await fs.kind(dataDir) === "folder" && await fs.kind(backup) === null) await fs.rename(dataDir, backup);
    if (await fs.kind(dataDir) === null) await fs.rename(aside, dataDir);
  }
  /** Moves back, trying again after an error, since a rename may have applied before its flush failed. */
  async function settleBack(): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await moveBack();
      } catch (error) {
        log("ledger-restore-move-back-failed", codeOf(error));
      }
      if (await fs.kind(aside) === null && await fs.kind(dataDir) === "folder") return true;
    }
    return false;
  }
  /** The swap is done: the record goes before anything opens the backup, and the open decides. */
  async function begin(state: PendingRestore) {
    await dropRecord();
    const next: PendingRestore = { ...state, state: "swapped", opens: state.state === "swapped" ? state.opens + 1 : 1 };
    // Unrecorded, the next launch finds the same folders and begins again.
    await tryTo("ledger-restore-pending-write-failed", () => write(next));
    return opening(next);
  }
  /** The restore opened: the signal goes first, and only then what it replaced. */
  async function markOpened(state: PendingRestore) {
    await writeOutcome({ status: "restored", takenAt });
    // An earlier restore's file is finished first, never renamed over: it names leftovers of its own.
    if (await finishEarlierOpened()) {
      await tryTo("ledger-restore-opened-rename-failed", () => fs.rename(pendingPath, openedPath));
    }
    if (await fs.kind(pendingPath) !== null) {
      // Without the opened file, a pending file that is gone is the signal; its leftovers then go as unnamed ones.
      await tryTo("ledger-restore-pending-removal-failed", () => fs.removeFile(pendingPath));
      if (await fs.kind(pendingPath) !== null) return;
      await removeUnnamedLeftovers();
      return;
    }
    await finishOpened(state);
  }
  async function abandon() {
    await tryTo("ledger-restore-sidecar-removal-failed", () => fs.removeFile(sidecar));
    await tryTo("ledger-restore-pending-removal-failed", () => fs.removeFile(pendingPath));
  }
  async function swapBack() {
    // Folders already back: a launch before this one swapped back and could not remove the file. Its ledger has run since,
    // and its clean-shutdown record is its own.
    if (await fs.kind(aside) === null && await fs.kind(dataDir) === "folder") {
      log("ledger-restore-swap-back-settled");
      // A launch that died before saying so leaves no outcome; one Settings already read is said again only while the file sticks.
      if (await fs.kind(outcomePath) === null) await writeOutcome({ status: "failed", backup: pending!.backup });
      await tryTo("ledger-restore-pending-removal-failed", () => fs.removeFile(pendingPath));
      return NONE;
    }
    if (!(await settleBack())) {
      if (await fs.kind(aside) === "folder") throw new Error("ledger-restore-swap-back-failed");
      log("ledger-restore-swap-back-incomplete");
    }
    // The ledger the person had lost its record at the swap; its next open checks every index.
    await dropRecord();
    return refuse("ledger-restore-swapped-back", true);
  }
  function opening(state: PendingRestore): LedgerRestoreLaunch {
    return {
      kind: "opening",
      canSwapBack: state.from === "settings",
      opened: () => markOpened(state).catch((error: unknown) => log("ledger-restore-finish-failed", codeOf(error))),
      async failed() {
        if (state.from === "settings") await write({ ...state, state: "swap-back" });
        else await abandon();
      },
    };
  }

  switch (pending.state) {
    case "swap-back":
      return swapBack();
    case "swapped": {
      // A clean close of the restored store wrote the record: it opened, whatever this file could not record then.
      if (await fs.kind(record) !== null && await swapped()) {
        await markOpened(pending).catch((error: unknown) => log("ledger-restore-finish-failed", codeOf(error)));
        return NONE;
      }
      // Nothing in the ledger's place, as after a switch back cut short between its renames: there is no used
      // ledger to lose, so the one set aside goes back, whichever dialog started the restore.
      if (await fs.kind(dataDir) !== "folder") return swapBack();
      // No signal either way: the last launches may have run on the restored ledger, so nothing swaps back on a guess.
      // After several, the person decides; trying again is the default.
      if (pending.opens >= STUCK_OPENS && deps.askStuck) {
        const choice = await deps.askStuck({ takenAt: new Date(takenAt), from: pending.from }).catch((error: unknown) => {
          log("ledger-restore-ask-failed", codeOf(error));
          return "retry" as const;
        });
        log("ledger-restore-stuck", choice);
        if (choice === "quit") return { kind: "quit" };
        if (choice === "swap-back") {
          // Recorded first, so a launch cut short finishes it; no worker exists yet, so it runs here.
          await tryTo("ledger-restore-pending-write-failed", () => write({ ...pending, state: "swap-back" }));
          return swapBack();
        }
      }
      return begin(pending);
    }
    case "requested": {
      const ledger = await fs.kind(dataDir);
      const asideKind = await fs.kind(aside);
      // Nothing has moved while the aside name is free: the first rename takes it.
      const untouched = asideKind === null;
      if (untouched) {
        const age = now.getTime() - Date.parse(pending.requestedAt);
        if (age > LEDGER_RESTORE_REQUEST_TTL_MS || age < -REQUEST_SKEW_MS) {
          return refuse("ledger-restore-request-stale");
        }
        if (!(await restorable())) return refuse("ledger-restore-not-restorable");
        if (ledger !== "folder") return refuse("ledger-restore-inconsistent");
      } else if (!(await swapped()) && !(ledger === null && asideKind === "folder")) {
        // Not a state any step of this restore leaves, and the backup is still under its own name: nothing is moved.
        return refuse("ledger-restore-inconsistent");
      }
      try {
        if (untouched) await fs.rename(dataDir, aside);
        if (await fs.kind(dataDir) === null) {
          if (!(await restorable())) throw new Error("ledger-restore-not-restorable");
          await fs.rename(backup, dataDir);
        }
      } catch (error) {
        log("ledger-restore-swap-failed", codeOf(error));
      }
      // The folders decide, not which call failed: a rename may have applied before its flush failed.
      if (await swapped()) return begin(pending);
      if (await settleBack()) return refuse("ledger-restore-rolled-back");
      throw new Error("ledger-restore-rollback-failed");
    }
  }
}
