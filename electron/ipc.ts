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
import type { AutomationSettingsStore } from "../src/lib/automation/server/config-files.ts";
import type { AppUpdateRestartResult, AppUpdateView } from "../src/lib/settings/app-updates.ts";
import type { ErrorReportInput, ErrorReportPayload, ErrorReportResult } from "../src/lib/automation/error-report-contract.ts";
import {
  isFiniteDisplayScale,
  trafficLightPositionForScale,
} from "./window-options.ts";
import { dataVersionStore } from "../src/lib/shared-shell/data-version.ts";
import { trustedIpcMain } from "./ipc-sender.ts";
import type { PGliteViewWorkerClient } from "./pglite-view-worker-client.ts";
import type { PGliteFinancialPort } from "../src/lib/pglite-rpc/pglite-financial-contracts.ts";

export function registerOctopusBeakIpc({
  automation,
  settings,
  spending,
  appUpdates,
  errorReports,
  pgliteWorker,
  pgliteFinancial,
  automationSettings,
  rendererUrl,
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
  /** The operational runtime's worker; the runtime owns closing it. */
  pgliteWorker: Pick<PGliteViewWorkerClient, "subscribe" | "onError" | "close">;
  pgliteFinancial: PGliteFinancialPort;
  automationSettings: AutomationSettingsStore;
  /** Only this document's top frame may call main (Electron security checklist: validate IPC senders). */
  rendererUrl: string;
}) {
  const ipc = trustedIpcMain(ipcMain, rendererUrl);
  const unsubscribeFromDataInvalidation = dataVersionStore.subscribe((event) => broadcast("data:invalidated", event));
  const financialPages = pgliteFinancial;
  const pgliteViewRegistration: PGliteViewIpcRegistration = registerPGliteViewIpc({
    worker: pgliteWorker,
    workerOwned: false,
  }, ipc);
  ipc.handle("data-views:enabled" satisfies OctopusBeakDataViewChannels["enabled"], () => true);
  ipc.on("display:setScale" satisfies OctopusBeakSendChannel, (event, percent: unknown) => {
    if (!isFiniteDisplayScale(percent)) return;
    event.sender.setZoomFactor(displayScaleZoomFactor(percent));
    if (process.platform !== "darwin") return;
    BrowserWindow.fromWebContents(event.sender)?.setWindowButtonPosition(
      trafficLightPositionForScale(percent),
    );
  });
  const unwatchPreviewVisibility = watchPreviewVisibility(automationSettings, () => {
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
    ipc.handle(channel, handler as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown);
  }
  return {
    close: async () => {
      unsubscribeFromDataInvalidation();
      unwatchPreviewVisibility();
      await pgliteViewRegistration.close();
    },
  };
}
