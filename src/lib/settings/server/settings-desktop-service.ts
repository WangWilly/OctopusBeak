import type { AutomationSettingsFile } from "../../automation/server/config-files.ts";
import { automationFlagEnabled } from "../../automation/statement-selection.ts";
import type { PGlitePreviewFinancialDataPort } from "../../../ledger/pglite/preview-financial-data.ts";
import type { deleteAllPreviewData } from "../../preview-sources/delete-preview-data.ts";
import type { DataVersionStore } from "../../shared-shell/data-version.ts";
import type {
  LedgerReclaimEstimate,
  LedgerReclaimProgress,
  LedgerReclaimResult,
} from "../../../ledger/pglite/reclaim.ts";
import type { LedgerReclaimEstimateDto, LedgerReclaimProgressDto, LedgerReclaimResultDto } from "../../desktop/api.ts";
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
    progress(): Promise<LedgerReclaimProgress | null>;
    stop(): Promise<boolean>;
  }>;
}>;

function reclaimResultDto(result: LedgerReclaimResult): LedgerReclaimResultDto {
  switch (result.status) {
    case "nothing-to-reclaim":
    case "already-running":
      return { status: result.status };
    case "not-enough-space":
      return { status: result.status, requiredFreeBytes: result.requiredFreeBytes, freeBytes: result.freeBytes };
    default:
      return {
        status: result.status,
        tableCount: result.tables.length,
        reclaimedBytes: Math.max(0, result.bytesBefore - result.bytesAfter),
      };
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
    async ledgerReclaimProgress(): Promise<LedgerReclaimProgressDto | null> {
      const progress = await deps.ledgerReclaim.progress();
      return progress && {
        index: progress.index,
        count: progress.count,
        reclaimedBytes: Math.max(0, progress.bytesBefore - progress.bytesAfter),
      };
    },
    stopLedgerReclaim: () => deps.ledgerReclaim.stop(),
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
