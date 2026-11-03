import {
  BrowserWindow,
  ipcMain,
  type IpcMainInvokeEvent,
} from "electron";
import {
  automationForwardHandlers,
  financialForwardHandlers,
  settingsForwardHandlers,
  spendingForwardHandlers,
  type OctopusBeakInvokeHandlers,
  type SettingsServiceForwards,
  type SpendingServiceForwards,
} from "./ipc-channels.ts";
import type { OctopusBeakDataViewChannels, OctopusBeakSendChannel } from "./preload.ts";
import { broadcast } from "./broadcast.ts";
import type { AutomationDesktopService } from "../src/lib/automation/server/automation-desktop-service.ts";
import {
  registerPGliteViewIpc,
  type PGliteViewIpcRegistration,
} from "./pglite-ipc.ts";
import { displayScaleZoomFactor } from "../src/lib/settings/display-zoom.ts";
import { watchPreviewVisibility } from "../src/lib/automation/server/settings.ts";
import type { AppUpdateRestartResult, AppUpdateView } from "../src/lib/settings/app-updates.ts";
import type { ErrorReportInput, ErrorReportPayload, ErrorReportResult } from "../src/lib/automation/server/error-report.ts";
import {
  isFiniteDisplayScale,
  trafficLightPositionForScale,
} from "./window-options.ts";
import { dataVersionStore } from "../src/lib/shared-shell/data-version.ts";
import type { PGliteViewWorkerClient } from "./pglite-view-worker-client.ts";
import type { PGliteFinancialPort } from "./pglite-financial-rpc-client.ts";

export function registerOctopusBeakIpc({
  automation,
  settings,
  spending,
  appUpdates,
  errorReports,
  pgliteViews,
  pgliteOperational,
  pgliteFinancial,
}: {
  automation: AutomationDesktopService<BrowserWindow | null>;
  settings: SettingsServiceForwards;
  spending: SpendingServiceForwards;
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
    worker?: Pick<PGliteViewWorkerClient, "subscribe" | "onError" | "close">;
    dataDir?: string;
    workerPath?: string;
  };
  pgliteFinancial: PGliteFinancialPort;
}) {
  const unsubscribeFromDataInvalidation = dataVersionStore.subscribe((event) => broadcast("data:invalidated", event));
  const financialPages = pgliteFinancial;
  const sharedPgliteWorker = pgliteOperational.worker;
  const pgliteViewRegistration: PGliteViewIpcRegistration = registerPGliteViewIpc({
    dataDir: pgliteOperational.dataDir ?? pgliteViews.dataDir ?? "",
    workerPath: pgliteOperational.workerPath ?? pgliteViews.workerPath,
    ...(sharedPgliteWorker ? { worker: sharedPgliteWorker, workerOwned: false } : {}),
  }, ipcMain);
  ipcMain.handle("data-views:enabled" satisfies OctopusBeakDataViewChannels["enabled"], () => true);
  ipcMain.on("display:setScale" satisfies OctopusBeakSendChannel, (event, percent: unknown) => {
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
    ...settingsForwardHandlers(settings),
    ...spendingForwardHandlers(spending),
    "automation:selectCertificateFile": (event, locale) =>
      automation.selectCertificateFile(BrowserWindow.fromWebContents(event.sender), locale),
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
