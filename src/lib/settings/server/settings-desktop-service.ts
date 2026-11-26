import type { AutomationSettingsFile } from "../../automation/server/config-files.ts";
import { automationFlagEnabled } from "../../automation/statement-selection.ts";
import type { DataVersionStore } from "../../shared-shell/data-version.ts";
import type {
  LedgerCompactionJobResult,
  LedgerCompactionProgress,
  LedgerCompactionRecordedFailure,
  LedgerCompactionRequest,
  LedgerCompactionStatus,
} from "../../../ledger/pglite/compaction-job.ts";
import type { DamagedLedger, LedgerCleanupBackup } from "../../../ledger/pglite/data-dir-backup.ts";
import type { LedgerCleanupEstimate } from "../../../ledger/pglite/cleanup-estimate.ts";
import type {
  CleanupBackupDto,
  CleanupRestoreOutcomeDto,
  DamagedLedgerDto,
  LedgerCleanupEstimateDto,
  LedgerCleanupProgressDto,
  LedgerCleanupResultDto,
  LedgerCleanupStatusDto,
} from "../../desktop/api.ts";
import {
  LEDGER_RESET_PARTS,
  resetLedger,
  type CollectionControl,
  type LedgerResetPart,
  type LedgerResetResult,
  type LedgerResetSteps,
} from "../data-erasure.ts";
import {
  systemSettings,
  systemSettingsFileEntries,
  validateSystemSettings,
  type SystemSettingsDto,
} from "../system-settings.ts";
import type { UsagePing } from "../usage-statistics.ts";

/** Everything the settings desktop service reaches outside itself. */
export type SettingsDesktopServiceDeps = Readonly<{
  settingsFile: Readonly<{
    read(): AutomationSettingsFile;
    write(settings: AutomationSettingsFile): void;
  }>;
  /** Awaited before a save returns, so the schedulers and updater see the new value first. */
  onSystemSettingsChanged?: (settings: SystemSettingsDto) => void | Promise<void>;
  usagePing: Readonly<{ preview(): UsagePing; shouldAsk(): boolean; answer(enabled: boolean): void }>;
  dataVersions: Pick<DataVersionStore, "snapshot" | "acknowledge" | "markStale">;
  collection: CollectionControl;
  /** The deletions Reset ledger runs, each on its own; the service stops collection around them. */
  ledgerReset: LedgerResetSteps;
  /** The ledger worker's App Data Cleanup (ADR 0154, ADR 0156): its estimate, the run, its status and its stop. */
  ledgerCleanup: Readonly<{
    estimate(): Promise<LedgerCleanupEstimate>;
    /** The service always says whether to keep the backup; the worker keeps it when told nothing. */
    run(request: Required<LedgerCompactionRequest>): Promise<LedgerCompactionJobResult>;
    status(): Promise<LedgerCompactionStatus>;
    stop(): Promise<boolean>;
  }>;
  /** The Cleanup Backup, which the main process reveals and deletes by the path the worker gives. */
  cleanupBackup: Readonly<{
    newest(): Promise<LedgerCleanupBackup | null>;
    reveal(path: string): void;
    remove(path: string): Promise<void>;
  }>;
  /** The damaged ledgers the unusable-ledger dialog set aside (ADR 0150), which the main process lists, reveals and deletes. */
  damagedLedgers: Readonly<{
    /** Newest first, each with an `id` the renderer may name it by. */
    list(): Promise<readonly DamagedLedger[]>;
    reveal(path: string): void;
    remove(path: string): Promise<void>;
    /** Whether a restore file names the folder at `path`, or one exists that cannot be read and so may. */
    heldByRestore(path: string): Promise<boolean>;
  }>;
  /** The Cleanup Restore (ADR 0157): the request the next launch carries out, and how the last one ended. */
  cleanupRestore: Readonly<{
    /** Whether a restore has been asked for and has not ended. */
    requested(): Promise<boolean>;
    /** Records, and flushes, that the backup at `path` takes the ledger's place at the next launch. */
    request(path: string): Promise<void>;
    /** Starts the App again through the ordinary quit, which closes the ledger cleanly. */
    restart(): void;
    /** How the last restore ended, once; the host forgets it as it is read. */
    takeOutcome(): Promise<CleanupRestoreOutcomeDto | null>;
  }>;
}>;

function cleanupResultDto(result: LedgerCompactionJobResult | LedgerCompactionRecordedFailure): LedgerCleanupResultDto {
  switch (result.status) {
    case "already-running": return { status: "already-running" };
    case "failed-earlier": return result.backup ? { status: "backup-failed" } : { status: "failed", freedBytes: 0 };
    case "stopped": return { status: "stopped", freedBytes: result.freedBytes ?? 0 };
    case "failed": return result.failure.reason === "backup" ? { status: "backup-failed" } : { status: "failed", freedBytes: result.freedBytes ?? 0 };
    case "compacted": {
      const { reclaim } = result;
      // Without a folder to measure, what the rewritten tables lost.
      const freedBytes = result.freedBytes
        ?? (reclaim.status === "reclaimed" || reclaim.status === "failed" ? Math.max(0, reclaim.bytesBefore - reclaim.bytesAfter) : 0);
      switch (reclaim.status) {
        case "not-enough-space":
          return {
            status: "no-room",
            freedBytes,
            remainingBytes: reclaim.reclaimableBytes,
            neededBytes: Math.max(0, reclaim.requiredFreeBytes - reclaim.freeBytes),
          };
        // A rewrite is one transaction: the table that failed is as it was.
        case "failed": return { status: "failed", freedBytes };
        default: return { status: "done", freedBytes };
      }
    }
  }
}

function cleanupProgressDto(progress: LedgerCompactionProgress): LedgerCleanupProgressDto {
  switch (progress.phase) {
    case "backing-up": return { phase: "backing-up" };
    case "compacting": return { phase: "compacting", index: progress.index, count: progress.count };
    case "reclaiming": return { phase: "reclaiming", index: progress.reclaim.index, count: progress.reclaim.count };
  }
}

/** Only the two choices: the renderer names no path, folder or other option. */
function cleanupRequest(input: unknown): Required<LedgerCompactionRequest> {
  if (typeof input !== "object" || input === null || Array.isArray(input)
    || Object.keys(input).some((key) => key !== "backup" && key !== "keepBackup")
    || typeof (input as { backup?: unknown }).backup !== "boolean"
    || typeof (input as { keepBackup?: unknown }).keepBackup !== "boolean") {
    throw new TypeError("A cleanup request must say whether to back up first and whether to keep the backup, and nothing else.");
  }
  const { backup, keepBackup } = input as { backup: boolean; keepBackup: boolean };
  return { backup, keepBackup };
}

/** A non-empty list of distinct parts Reset ledger knows, and nothing else. */
function ledgerResetRequest(input: unknown): ReadonlySet<LedgerResetPart> {
  const parts = Array.isArray(input) ? new Set<unknown>(input) : null;
  if (!parts || parts.size === 0 || parts.size !== (input as unknown[]).length
    || [...parts].some((part) => !(LEDGER_RESET_PARTS as readonly unknown[]).includes(part))) {
    throw new TypeError("A ledger reset must name at least one known part, each once.");
  }
  return parts as ReadonlySet<LedgerResetPart>;
}

function cleanupEstimateDto(estimate: LedgerCleanupEstimate): LedgerCleanupEstimateDto {
  return {
    redundantBytes: estimate.redundantBytes,
    temporaryBytes: estimate.temporaryBytes,
    neededBytes: estimate.reclaimNeededBytes,
    freeBytes: estimate.freeBytes,
    backup: estimate.backup === null ? null
      : estimate.backup === "unreadable" ? { kind: "unreadable" }
      : { kind: "room", bytes: estimate.backup.storeBytes, neededBytes: estimate.backup.neededBytes },
  };
}

function cleanupBackupDto(backup: LedgerCleanupBackup | null): CleanupBackupDto | null {
  return backup && { bytes: backup.bytes, takenAt: backup.takenAt, expiresAt: backup.expiresAt, restorable: backup.restorable };
}

function damagedLedgerDto(ledger: DamagedLedger): DamagedLedgerDto {
  return { id: ledger.id, bytes: ledger.bytes, setAsideAt: ledger.setAsideAt.toISOString() };
}

/** The UTC time in a damaged ledger's name, `2026-11-20T08-00-00Z` or with a `-N` after it, and nothing else. */
const DAMAGED_LEDGER_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(?:-\d+)?$/u;

function damagedLedgerId(input: unknown): string {
  if (typeof input !== "string" || !DAMAGED_LEDGER_ID.test(input)) throw new TypeError("A damaged ledger is named by the time in its name, and nothing else.");
  return input;
}

export type SettingsDesktopService = ReturnType<typeof createSettingsDesktopService>;

export function createSettingsDesktopService(deps: SettingsDesktopServiceDeps) {
  const { settingsFile, usagePing, dataVersions } = deps;
  // Set before the cleanup's status is read, so a cleanup asked for meanwhile is refused too.
  let resetting = false;
  // Set once a restore is being asked for; it stays set, since the App restarts.
  let restoring = false;
  const assertNoRestore = async (action: string) => {
    if (restoring || await deps.cleanupRestore.requested()) throw new Error(`${action} once a restore is asked for.`);
  };
  return {
    load: () => systemSettings(settingsFile.read()),
    async save(input: SystemSettingsDto) {
      const value = validateSystemSettings(input);
      const current = settingsFile.read();
      // Changing the switch in Settings answers the one-time usage statistics question too.
      // Read only the flag, so a corrupt stored value elsewhere cannot block the save that repairs it.
      const usageAnswered = automationFlagEnabled(current.USAGE_STATISTICS_ENABLED) !== value.usageStatisticsEnabled;
      settingsFile.write({
        ...current,
        ...systemSettingsFileEntries(value),
        ...(usageAnswered ? { USAGE_STATISTICS_PROMPTED: "true" } : {}),
      });
      await deps.onSystemSettingsChanged?.(value);
      return value;
    },
    previewUsagePing: () => usagePing.preview(),
    shouldAskUsageStatistics: () => usagePing.shouldAsk(),
    answerUsageStatistics(enabled: unknown) {
      if (typeof enabled !== "boolean") throw new TypeError("The usage statistics answer must be a boolean.");
      usagePing.answer(enabled);
      return systemSettings(settingsFile.read());
    },
    async resetLedger(request: unknown): Promise<LedgerResetResult> {
      const parts = ledgerResetRequest(request);
      // The renderer's own guards are not the only ones: a cleanup copies, compacts and rewrites the store a reset empties.
      if (resetting) throw new Error("The ledger is already being reset.");
      resetting = true;
      try {
        // A reset removes the Cleanup Backup, which a restore asked for is about to use.
        await assertNoRestore("The ledger cannot be reset");
        if ((await deps.ledgerCleanup.status()).running) throw new Error("The ledger cannot be reset while a cleanup runs.");
        return await resetLedger(deps.collection, deps.ledgerReset, dataVersions, parts);
      } finally {
        resetting = false;
      }
    },
    ledgerCleanupEstimate: async () => cleanupEstimateDto(await deps.ledgerCleanup.estimate()),
    // Removes only rows no reader answers differently without, and rewrites tables, so no data version moves and no view reloads.
    async cleanUpLedger(request: unknown): Promise<LedgerCleanupResultDto> {
      const parsed = cleanupRequest(request);
      if (resetting) throw new Error("A cleanup cannot start while the ledger is being reset.");
      // A cleanup takes a new backup, which replaces the one a restore asked for.
      await assertNoRestore("A cleanup cannot start");
      return cleanupResultDto(await deps.ledgerCleanup.run(parsed));
    },
    async ledgerCleanupStatus(): Promise<LedgerCleanupStatusDto> {
      const status = await deps.ledgerCleanup.status();
      if (status.running) return { running: true, progress: status.progress && cleanupProgressDto(status.progress) };
      return { running: false, last: status.last && cleanupResultDto(status.last) };
    },
    stopLedgerCleanup: () => deps.ledgerCleanup.stop(),
    cleanupBackup: async () => cleanupBackupDto(await deps.cleanupBackup.newest()),
    async revealCleanupBackup(): Promise<void> {
      const backup = await deps.cleanupBackup.newest();
      if (backup) deps.cleanupBackup.reveal(backup.path);
    },
    async deleteCleanupBackup(): Promise<CleanupBackupDto | null> {
      // A running cleanup may be taking or removing a backup; the renderer's own guard is not the only one.
      if ((await deps.ledgerCleanup.status()).running) throw new Error("A backup cannot be deleted while a cleanup runs.");
      await assertNoRestore("A backup cannot be deleted");
      // At most one exists, but a version before ADR 0156 could leave several; none stays.
      for (let backup = await deps.cleanupBackup.newest(); backup; backup = await deps.cleanupBackup.newest()) {
        await deps.cleanupBackup.remove(backup.path);
      }
      return null;
    },
    /**
     * Asks for the Cleanup Restore of ADR 0157 and restarts the App to carry
     * it out. Refused while a cleanup or a reset runs, and when the backup
     * cannot be restored. Collection stops first and does not start again:
     * the App quits once the request is flushed.
     */
    async restoreCleanupBackup(): Promise<void> {
      if (resetting) throw new Error("The backup cannot be restored while the ledger is being reset.");
      if (restoring) throw new Error("The backup cannot be restored again once a restore is asked for.");
      // Set before anything is read, so a reset or a cleanup asked for meanwhile is refused.
      restoring = true;
      let resume: (() => void) | null = null;
      try {
        if (await deps.cleanupRestore.requested()) throw new Error("The backup cannot be restored again once a restore is asked for.");
        if ((await deps.ledgerCleanup.status()).running) throw new Error("The backup cannot be restored while a cleanup runs.");
        const backup = await deps.cleanupBackup.newest();
        if (!backup?.restorable) throw new Error("There is no backup that can be restored.");
        resume = deps.collection.pauseSchedules();
        await deps.collection.whileStopped(() => deps.cleanupRestore.request(backup.path));
      } catch (error) {
        restoring = false;
        resume?.();
        throw error;
      }
      deps.cleanupRestore.restart();
    },
    takeCleanupRestoreOutcome: () => deps.cleanupRestore.takeOutcome(),
    damagedLedgers: async (): Promise<readonly DamagedLedgerDto[]> => (await deps.damagedLedgers.list()).map(damagedLedgerDto),
    async revealDamagedLedger(id: unknown): Promise<void> {
      const wanted = damagedLedgerId(id);
      const ledger = (await deps.damagedLedgers.list()).find((entry) => entry.id === wanted);
      if (ledger) deps.damagedLedgers.reveal(ledger.path);
    },
    /**
     * Deletes the damaged ledger the renderer names, found by its id among the
     * folders listed now; the id never becomes part of a path. One already
     * gone leaves nothing to delete. Refused while a cleanup or a reset runs,
     * once a restore is asked for, and while a restore file names the folder
     * or cannot be read.
     */
    async deleteDamagedLedger(id: unknown): Promise<readonly DamagedLedgerDto[]> {
      const wanted = damagedLedgerId(id);
      if (resetting) throw new Error("A damaged ledger cannot be deleted while the ledger is being reset.");
      if ((await deps.ledgerCleanup.status()).running) throw new Error("A damaged ledger cannot be deleted while a cleanup runs.");
      await assertNoRestore("A damaged ledger cannot be deleted");
      const ledger = (await deps.damagedLedgers.list()).find((entry) => entry.id === wanted);
      if (ledger) {
        // A restore from the unusable-ledger dialog names its damaged ledger, which a swap back puts in the ledger's place.
        if (await deps.damagedLedgers.heldByRestore(ledger.path)) throw new Error("A damaged ledger a restore may name cannot be deleted.");
        await deps.damagedLedgers.remove(ledger.path);
      }
      return (await deps.damagedLedgers.list()).map(damagedLedgerDto);
    },
    getVersion: () => dataVersions.snapshot(),
    acknowledgeVersion(version: unknown) {
      if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) {
        throw new TypeError("Data version must be a non-negative safe integer.");
      }
      dataVersions.acknowledge(version);
      return dataVersions.snapshot();
    },
  };
}
