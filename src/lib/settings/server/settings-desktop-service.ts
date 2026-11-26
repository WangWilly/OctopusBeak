import type { AutomationSettingsFile } from "../../automation/server/config-files.ts";
import { automationFlagEnabled } from "../../automation/statement-selection.ts";
import type { PGlitePreviewFinancialDataPort } from "../../../ledger/pglite/preview-financial-data.ts";
import type { deleteAllPreviewData } from "../../preview-sources/delete-preview-data.ts";
import type { DataVersionStore } from "../../shared-shell/data-version.ts";
import type {
  LedgerCompactionJobResult,
  LedgerCompactionProgress,
  LedgerCompactionRecordedFailure,
  LedgerCompactionRequest,
  LedgerCompactionStatus,
} from "../../../ledger/pglite/compaction-job.ts";
import type { LedgerCleanupBackup } from "../../../ledger/pglite/data-dir-backup.ts";
import type { LedgerCleanupEstimate } from "../../../ledger/pglite/cleanup-estimate.ts";
import type {
  CleanupBackupDto,
  LedgerCleanupEstimateDto,
  LedgerCleanupProgressDto,
  LedgerCleanupResultDto,
  LedgerCleanupStatusDto,
} from "../../desktop/api.ts";
import type { CollectionControl, deleteAllFinancialData } from "../data-erasure.ts";
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
  preview: Pick<PGlitePreviewFinancialDataPort, "deleteAll">;
  financial: Readonly<{ reset(): Promise<void> }>;
  deleteAllPreviewData: typeof deleteAllPreviewData;
  deleteAllFinancialData: typeof deleteAllFinancialData;
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

export type SettingsDesktopService = ReturnType<typeof createSettingsDesktopService>;

export function createSettingsDesktopService(deps: SettingsDesktopServiceDeps) {
  const { settingsFile, usagePing, dataVersions } = deps;
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
    deletePreviewData: () => deps.deleteAllPreviewData(deps.preview, dataVersions),
    deleteFinancialData: () => deps.deleteAllFinancialData(deps.collection, deps.financial, dataVersions),
    ledgerCleanupEstimate: async () => cleanupEstimateDto(await deps.ledgerCleanup.estimate()),
    // Removes only rows no reader answers differently without, and rewrites tables, so no data version moves and no view reloads.
    cleanUpLedger: async (request: unknown) => cleanupResultDto(await deps.ledgerCleanup.run(cleanupRequest(request))),
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
      // At most one exists, but a version before ADR 0156 could leave several; none stays.
      for (let backup = await deps.cleanupBackup.newest(); backup; backup = await deps.cleanupBackup.newest()) {
        await deps.cleanupBackup.remove(backup.path);
      }
      return null;
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
