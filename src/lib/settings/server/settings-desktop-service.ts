import type { AutomationSettingsFile } from "../../automation/server/config-files.ts";
import { automationFlagEnabled } from "../../automation/statement-selection.ts";
import type { PGlitePreviewFinancialDataPort } from "../../../ledger/pglite/preview-financial-data.ts";
import type { deleteAllPreviewData } from "../../preview-sources/delete-preview-data.ts";
import type { DataVersionStore } from "../../shared-shell/data-version.ts";
import type {
  LedgerReclaimEstimate,
  LedgerReclaimResult,
  LedgerReclaimStatus,
} from "../../../ledger/pglite/reclaim.ts";
import type { CompactionPlanResult } from "../../../ledger/pglite/compaction-plan.ts";
import type {
  LedgerCompactionJobResult,
  LedgerCompactionProgress,
  LedgerCompactionRecordedFailure,
  LedgerCompactionRequest,
  LedgerCompactionStatus,
} from "../../../ledger/pglite/compaction-job.ts";
import type { LedgerBackupRoom } from "../../../ledger/pglite/data-dir-backup.ts";
import type {
  LedgerCompactionEstimateDto,
  LedgerCompactionProgressDto,
  LedgerCompactionResultDto,
  LedgerCompactionStatusDto,
  LedgerReclaimEstimateDto,
  LedgerReclaimResultDto,
  LedgerReclaimStatusDto,
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
  /** The ledger worker's space reclaim (ADR 0155). */
  ledgerReclaim: Readonly<{
    estimate(): Promise<LedgerReclaimEstimate>;
    reclaim(): Promise<LedgerReclaimResult>;
    status(): Promise<LedgerReclaimStatus>;
    stop(): Promise<boolean>;
  }>;
  /** The ledger worker's compaction (ADR 0154) and its dry run. */
  ledgerCompaction: Readonly<{
    plan(): Promise<CompactionPlanResult>;
    backupRoom(): Promise<LedgerBackupRoom | null>;
    compact(request: LedgerCompactionRequest): Promise<LedgerCompactionJobResult>;
    status(): Promise<LedgerCompactionStatus>;
    stop(): Promise<boolean>;
  }>;
}>;

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

function compactionResultDto(result: LedgerCompactionJobResult | LedgerCompactionRecordedFailure): LedgerCompactionResultDto {
  if (result.status === "already-compacted" || result.status === "already-running") return { status: result.status };
  if (result.status === "failed-earlier") return { status: "failed", removedRows: result.removedRows, backup: result.backup };
  const removedRows = sum(Object.values(result.removed));
  switch (result.status) {
    case "stopped": return { status: "stopped", removedRows };
    case "failed": return { status: "failed", removedRows, backup: result.failure.reason === "backup" };
    case "compacted": {
      const reclaim = reclaimResultDto(result.reclaim);
      // A reclaim that found too little room or failed left the space for Reclaim ledger space.
      const reclaimedBytes = reclaim.status === "nothing-to-reclaim" ? 0 : reclaim.status === "reclaimed" ? reclaim.reclaimedBytes : null;
      return { status: "compacted", removedRows, reclaimedBytes };
    }
  }
}

function compactionProgressDto(progress: LedgerCompactionProgress): LedgerCompactionProgressDto {
  switch (progress.phase) {
    case "backing-up": return { phase: "backing-up" };
    case "compacting": return { phase: "compacting", index: progress.index, count: progress.count, removedRows: progress.removedRows };
    case "reclaiming":
      return { phase: "reclaiming", index: progress.reclaim.index, count: progress.reclaim.count, removedRows: progress.removedRows };
  }
}

function compactionRequest(input: unknown): LedgerCompactionRequest {
  if (typeof input !== "object" || input === null || typeof (input as { backup?: unknown }).backup !== "boolean") {
    throw new TypeError("A compaction request must say whether to back up first.");
  }
  return { backup: (input as { backup: boolean }).backup };
}

function reclaimResultDto(result: LedgerReclaimResult): LedgerReclaimResultDto {
  switch (result.status) {
    case "nothing-to-reclaim":
    case "already-running":
      return { status: result.status };
    case "not-enough-space":
      return { status: result.status, requiredFreeBytes: result.requiredFreeBytes, freeBytes: result.freeBytes };
    default: {
      const folder = result.folderBytesBefore !== null && result.folderBytesAfter !== null
        ? result.folderBytesBefore - result.folderBytesAfter
        : null;
      return {
        status: result.status,
        tableCount: result.tables.length,
        reclaimedBytes: Math.max(0, folder ?? result.bytesBefore - result.bytesAfter),
      };
    }
  }
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
    async ledgerReclaimEstimate(): Promise<LedgerReclaimEstimateDto> {
      const estimate = await deps.ledgerReclaim.estimate();
      return {
        reclaimableBytes: estimate.reclaimableBytes,
        tableCount: estimate.tables.length,
        requiredFreeBytes: estimate.requiredFreeBytes,
        freeBytes: estimate.freeBytes,
      };
    },
    // Changes no row, so no data version moves and no view reloads.
    reclaimLedgerSpace: async () => reclaimResultDto(await deps.ledgerReclaim.reclaim()),
    async ledgerReclaimStatus(): Promise<LedgerReclaimStatusDto> {
      const status = await deps.ledgerReclaim.status();
      if (status.running) {
        return { running: true, progress: status.progress && { index: status.progress.index, count: status.progress.count } };
      }
      return { running: false, last: status.last && reclaimResultDto(status.last) };
    },
    stopLedgerReclaim: () => deps.ledgerReclaim.stop(),
    async ledgerCompactionEstimate(): Promise<LedgerCompactionEstimateDto> {
      const [plan, room] = await Promise.all([deps.ledgerCompaction.plan(), deps.ledgerCompaction.backupRoom()]);
      if (plan.status !== "planned") return { status: "cannot-compact" };
      return {
        status: "planned",
        removableRows: sum([...plan.phaseA, ...plan.phaseB.tables, plan.phaseC].map((table) => table.removable)),
        removableBytes: plan.estimatedBytes,
        storeBytes: room?.storeBytes ?? null,
        freeBytes: room?.freeBytes ?? null,
      };
    },
    // Removes only rows no reader answers differently without, so no data version moves and no view reloads.
    compactLedger: async (request: unknown) => compactionResultDto(await deps.ledgerCompaction.compact(compactionRequest(request))),
    async ledgerCompactionStatus(): Promise<LedgerCompactionStatusDto> {
      const status = await deps.ledgerCompaction.status();
      if (status.running) return { running: true, progress: status.progress && compactionProgressDto(status.progress) };
      return { running: false, last: status.last && compactionResultDto(status.last) };
    },
    stopLedgerCompaction: () => deps.ledgerCompaction.stop(),
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
