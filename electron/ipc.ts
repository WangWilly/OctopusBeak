import { BrowserWindow, ipcMain } from "electron";
import {
  createDataIssueIpcHandlers,
} from "../src/lib/desktop/api.ts";
import { loadAssets } from "../src/lib/assets/server/load-assets.ts";
import {
  automationCancel,
  automationResume,
  automationRun,
  automationRunMany,
  automationRunHistory,
  automationSaveCredentials,
  loadAutomationDesktopModel,
} from "../src/lib/automation/server/desktop-api.ts";
import {
  captureSessionScreenshot,
  isClosedViewerSessionError,
  inspectViewerPoint,
  sendViewerInput,
} from "../src/lib/automation/server/automation-viewer.ts";
import {
  forceQuitHumanSessionForTask,
  humanSessionForTask,
} from "../src/lib/automation/server/human-session.ts";
import { loadLiabilities } from "../src/lib/liabilities/server/load-liabilities.ts";
import { loadOverview } from "../src/lib/overview/server/load-overview.ts";
import {
  loadSpending,
  updateSpendingItemCategory,
  updateSpendingTransactionOverride,
  type SpendingLoadInput,
  type SpendingOverrideUpdate,
} from "../src/lib/spending/server/store.ts";
import {
  readAutomationSettings,
} from "../src/lib/automation/server/settings.ts";
import { writeAutomationSettings } from "../src/lib/automation/server/config-files.ts";
import {
  confirmDataIssueExclusion,
  confirmDataIssueRestore,
  createDataIssue,
  listDataIssues,
  loadDataIssue,
  previewDataIssueExclusion,
  previewDataIssueRestore,
  startDataIssueDiagnosis,
} from "../src/lib/data-issues/server/store.ts";
import {
  systemSettings,
  validateSystemSettings,
  type SystemSettingsDto,
} from "../src/lib/settings/system-settings.ts";
import { isFiniteDisplayScale, trafficLightPositionForScale } from "./window-options.ts";

export function registerOctopusBeakIpc({
  onSystemSettingsChanged,
}: {
  onSystemSettingsChanged?: (settings: SystemSettingsDto) => void | Promise<void>;
} = {}) {
  const dataIssueHandlers = createDataIssueIpcHandlers({
    list: listDataIssues,
    create: createDataIssue,
    load: loadDataIssue,
    startDiagnosis: startDataIssueDiagnosis,
    previewExclusion: previewDataIssueExclusion,
    confirmExclusion: confirmDataIssueExclusion,
    previewRestore: previewDataIssueRestore,
    confirmRestore: confirmDataIssueRestore,
  });
  ipcMain.on("display:setScale", (event, percent: unknown) => {
    if (process.platform !== "darwin") return;
    if (!isFiniteDisplayScale(percent)) return;
    BrowserWindow.fromWebContents(event.sender)?.setWindowButtonPosition(
      trafficLightPositionForScale(percent),
    );
  });
  ipcMain.handle("settings:load", () => systemSettings(readAutomationSettings()));
  ipcMain.handle("settings:save", async (_event, input: SystemSettingsDto) => {
    const value = validateSystemSettings(input);
    writeAutomationSettings({
      ...readAutomationSettings(),
      SYSTEM_TIMEZONE: value.systemTimezone,
      EXCHANGE_RATE_UPDATE_TIME: value.exchangeRateUpdateTime,
    });
    await onSystemSettingsChanged?.(value);
    return value;
  });
  ipcMain.handle("overview:load", () => loadOverview());
  ipcMain.handle("assets:load", () => loadAssets());
  ipcMain.handle("liabilities:load", () => loadLiabilities());
  ipcMain.handle("spending:load", (_event, input: SpendingLoadInput | undefined) =>
    loadSpending(undefined, input)
  );
  ipcMain.handle("spending:updateItemCategory", async (_event, input) => {
    await updateSpendingItemCategory(input);
    return { ok: true as const };
  });
  ipcMain.handle("spending:updateTransactionOverride", (_event, input: SpendingOverrideUpdate) => {
    updateSpendingTransactionOverride(input);
    return { ok: true as const };
  });
  ipcMain.handle("automation:load", () => loadAutomationDesktopModel());
  ipcMain.handle(
    "automation:saveCredentials",
    (_event, updates: Record<string, string>) => automationSaveCredentials(updates),
  );
  ipcMain.handle("automation:run", (_event, taskId: string) => automationRun(taskId));
  ipcMain.handle("automation:runMany", (_event, taskIds: string[]) => automationRunMany(taskIds));
  ipcMain.handle("automation:resume", (_event, taskId: string) => automationResume(taskId));
  ipcMain.handle("automation:cancel", (_event, taskId: string) => automationCancel(taskId));
  ipcMain.handle("automation:runHistory", () => automationRunHistory());
  ipcMain.handle("automation:viewerScreenshot", async (_event, taskId: string) => {
    const session = humanSessionForTask(taskId);
    try {
      return new Uint8Array(await captureSessionScreenshot(session));
    } catch (error) {
      if (isClosedViewerSessionError(error)) return null;
      throw error;
    }
  });
  ipcMain.handle("automation:viewerInspect", async (_event, taskId: string, point: unknown) => {
    const session = humanSessionForTask(taskId);
    return inspectViewerPoint(session, point);
  });
  ipcMain.handle("automation:viewerInput", async (_event, taskId: string, input: unknown) => {
    const session = humanSessionForTask(taskId);
    await sendViewerInput(session, input);
    return { ok: true as const };
  });
  ipcMain.handle("automation:forceQuit", async (_event, taskId: string) => {
    await forceQuitHumanSessionForTask(taskId);
    return { ok: true as const, closed: true };
  });
  ipcMain.handle("dataIssues:list", dataIssueHandlers.list);
  ipcMain.handle("dataIssues:create", dataIssueHandlers.create);
  ipcMain.handle("dataIssues:load", dataIssueHandlers.load);
  ipcMain.handle("dataIssues:startDiagnosis", dataIssueHandlers.startDiagnosis);
  ipcMain.handle("dataIssues:previewExclusion", dataIssueHandlers.previewExclusion);
  ipcMain.handle("dataIssues:confirmExclusion", dataIssueHandlers.confirmExclusion);
  ipcMain.handle("dataIssues:previewRestore", dataIssueHandlers.previewRestore);
  ipcMain.handle("dataIssues:confirmRestore", dataIssueHandlers.confirmRestore);
}
