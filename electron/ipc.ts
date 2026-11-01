import {
  BrowserWindow,
  ipcMain,
  type IpcMainInvokeEvent,
} from "electron";
import {
  automationForwardHandlers,
  financialForwardHandlers,
  type OctopusBeakInvokeHandlers,
} from "./ipc-channels.ts";
import type { AutomationDesktopService } from "../src/lib/automation/server/automation-desktop-service.ts";
import {
  registerPGliteViewIpc,
  type PGliteViewIpcRegistration,
} from "./pglite-ipc.ts";
import { displayScaleZoomFactor } from "../src/lib/settings/display-zoom.ts";
import { readAutomationSettings, watchPreviewVisibility } from "../src/lib/automation/server/settings.ts";
import { writeAutomationSettings } from "../src/lib/automation/server/config-files.ts";
import { automationFlagEnabled } from "../src/lib/automation/statement-selection.ts";
import {
  deleteAllFinancialData,
  type CollectionControl,
} from "../src/lib/settings/data-erasure.ts";
import { deleteAllPreviewData } from "../src/lib/preview-sources/delete-preview-data.ts";
import type { PGlitePreviewFinancialDataPort } from "../src/ledger/pglite/preview-financial-data.ts";
import {
  systemSettings,
  systemSettingsFileEntries,
  validateSystemSettings,
  type SystemSettingsDto,
} from "../src/lib/settings/system-settings.ts";
import type { UsagePing } from "../src/lib/settings/usage-statistics.ts";
import type { AppUpdateRestartResult, AppUpdateView } from "../src/lib/settings/app-updates.ts";
import type { ErrorReportInput, ErrorReportPayload, ErrorReportResult } from "../src/lib/automation/server/error-report.ts";
import {
  isFiniteDisplayScale,
  trafficLightPositionForScale,
} from "./window-options.ts";
import { dataVersionStore } from "../src/lib/shared-shell/data-version.ts";
import type { AutomationPersistenceProvider } from "../src/lib/automation/server/store.ts";
import type { ExchangeRatePersistencePort } from "../src/ledger/exchange-rates.ts";
import type { PGliteViewWorkerClient } from "./pglite-view-worker-client.ts";
import {
  prewarmPGlitePairingCandidates,
  type PGliteFinancialPort,
} from "./pglite-financial-registry.ts";
import type {
  SpendingCandidatePageRequest,
} from "../src/lib/spending/model.ts";

export function registerOctopusBeakIpc({
  automation,
  collection,
  onSystemSettingsChanged,
  usagePing,
  appUpdates,
  errorReports,
  pgliteViews,
  pgliteOperational,
  pgliteFinancial,
}: {
  automation: AutomationDesktopService<BrowserWindow | null>;
  collection: CollectionControl;
  onSystemSettingsChanged?: (
    settings: SystemSettingsDto,
  ) => void | Promise<void>;
  usagePing: { preview(): UsagePing; shouldAsk(): boolean; answer(enabled: boolean): void };
  appUpdates: { view(): AppUpdateView; check(): void; download(): void; restart(): AppUpdateRestartResult };
  errorReports: {
    available(): boolean;
    preview(input: ErrorReportInput): ErrorReportPayload;
    send(input: ErrorReportInput): Promise<ErrorReportResult>;
  };
  pgliteViews: {
    dataDir?: string;
    workerPath?: string;
  };
  pgliteOperational: {
    provider: AutomationPersistenceProvider & {
      exchangeRates: ExchangeRatePersistencePort;
      preview: Pick<PGlitePreviewFinancialDataPort, "deleteAll">;
    };
    worker?: Pick<PGliteViewWorkerClient, "subscribe" | "onError" | "close">;
    dataDir?: string;
    workerPath?: string;
  };
  pgliteFinancial: PGliteFinancialPort;
}) {
  const operationalProvider = pgliteOperational.provider;
  const unsubscribeFromDataInvalidation = dataVersionStore.subscribe((event) => {
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) window.webContents.send("data:invalidated", event);
    }
  });
  const financialPages = pgliteFinancial;
  const spendingCandidatePageControllers = new Map<string, AbortController>();
  const sharedPgliteWorker = pgliteOperational.worker;
  const pgliteViewRegistration: PGliteViewIpcRegistration = registerPGliteViewIpc({
    dataDir: pgliteOperational.dataDir ?? pgliteViews.dataDir ?? "",
    workerPath: pgliteOperational.workerPath ?? pgliteViews.workerPath,
    ...(sharedPgliteWorker ? { worker: sharedPgliteWorker, workerOwned: false } : {}),
  }, ipcMain);
  ipcMain.handle("data-views:enabled", () => true);
  ipcMain.on("display:setScale", (event, percent: unknown) => {
    if (!isFiniteDisplayScale(percent)) return;
    event.sender.setZoomFactor(displayScaleZoomFactor(percent));
    if (process.platform !== "darwin") return;
    BrowserWindow.fromWebContents(event.sender)?.setWindowButtonPosition(
      trafficLightPositionForScale(percent),
    );
  });
  const unwatchPreviewVisibility = watchPreviewVisibility(() => {
    dataVersionStore.markStale("preview-data-changed");
    void financialPages.request("financial.preview.visibilityChanged", [])
      .catch((error) => console.error("preview-visibility-refresh-failed", error));
  });
  const invokeHandlers: OctopusBeakInvokeHandlers = {
    ...financialForwardHandlers(pgliteFinancial),
    ...automationForwardHandlers(automation),
    "automation:selectCertificateFile": (event, locale) =>
      automation.selectCertificateFile(BrowserWindow.fromWebContents(event.sender), locale),
    "settings:load": () =>
      systemSettings(readAutomationSettings()),
    "settings:save": async (_event, input: SystemSettingsDto) => {
      const value = validateSystemSettings(input);
      const current = readAutomationSettings();
      // Changing the switch in Settings answers the one-time usage statistics question too.
      // Read only the flag, so a corrupt stored value elsewhere cannot block the save that repairs it.
      const usageAnswered = automationFlagEnabled(current.USAGE_STATISTICS_ENABLED) !== value.usageStatisticsEnabled;
      writeAutomationSettings({
        ...current,
        ...systemSettingsFileEntries(value),
        ...(usageAnswered ? { USAGE_STATISTICS_PROMPTED: "true" } : {}),
      });
      await onSystemSettingsChanged?.(value);
      return value;
    },
    "settings:previewUsagePing": () => usagePing.preview(),
    "settings:shouldAskUsageStatistics": () => usagePing.shouldAsk(),
    "settings:answerUsageStatistics": (_event, enabled: boolean) => {
      if (typeof enabled !== "boolean") throw new TypeError("The usage statistics answer must be a boolean.");
      usagePing.answer(enabled);
      return systemSettings(readAutomationSettings());
    },
    "appUpdates:view": () => appUpdates.view(),
    "appUpdates:check": () => {
      appUpdates.check();
      return appUpdates.view();
    },
    "appUpdates:download": () => {
      appUpdates.download();
      return appUpdates.view();
    },
    "appUpdates:restart": () => appUpdates.restart(),
    "errorReports:available": () => errorReports.available(),
    "errorReports:preview": (_event, input: ErrorReportInput) => errorReports.preview(input),
    "errorReports:send": (_event, input: ErrorReportInput) => errorReports.send(input),
    "settings:deletePreviewData": () =>
      deleteAllPreviewData(operationalProvider.preview, dataVersionStore),
    "settings:deleteFinancialData": () => deleteAllFinancialData(
      collection,
      { reset: () => pgliteFinancial.request("financial.canonical.reset", []) },
      dataVersionStore,
    ),
    "spending:candidate-page": async (_event, request: SpendingCandidatePageRequest, requestId: string) => {
      if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 160)
        throw new TypeError("Spending candidate page request id is invalid.");
      if (spendingCandidatePageControllers.has(requestId))
        throw new Error("Spending candidate page request id is already active.");
      const controller = new AbortController();
      spendingCandidatePageControllers.set(requestId, controller);
      try {
        return await pgliteFinancial.request("financial.spending.candidatePage", [request], { signal: controller.signal });
      } finally {
        if (spendingCandidatePageControllers.get(requestId) === controller)
          spendingCandidatePageControllers.delete(requestId);
      }
    },
    "spending:candidate-page-cancel": (_event, requestId: string) => {
      if (typeof requestId !== "string") return false;
      const controller = spendingCandidatePageControllers.get(requestId);
      if (!controller) return false;
      controller.abort();
      return true;
    },
    "spending:pairing-prewarm": (_event, input) =>
      prewarmPGlitePairingCandidates(financialPages, input),
    "data:getVersion": () => dataVersionStore.snapshot(),
    "data:acknowledgeVersion": (_event, version: unknown) => {
      if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) {
        throw new TypeError("Data version must be a non-negative safe integer.");
      }
      dataVersionStore.acknowledge(version);
      return dataVersionStore.snapshot();
    },
  };
  for (const [channel, handler] of Object.entries(invokeHandlers)) {
    ipcMain.handle(channel, handler as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown);
  }
  return {
    close: async () => {
      unsubscribeFromDataInvalidation();
      unwatchPreviewVisibility();
      await pgliteViewRegistration.close();
    },
  };
}
