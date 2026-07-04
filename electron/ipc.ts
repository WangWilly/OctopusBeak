import { ipcMain } from "electron";
import { loadAssets } from "../src/lib/assets/server/load-assets.ts";
import {
  automationCancel,
  automationResume,
  automationRun,
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

export function registerOctopusBeakIpc() {
  ipcMain.handle("overview:load", () => loadOverview());
  ipcMain.handle("assets:load", () => loadAssets());
  ipcMain.handle("liabilities:load", () => loadLiabilities());
  ipcMain.handle("automation:load", () => loadAutomationDesktopModel());
  ipcMain.handle(
    "automation:saveCredentials",
    (_event, updates: Record<string, string>) => automationSaveCredentials(updates),
  );
  ipcMain.handle("automation:run", (_event, taskId: string) => automationRun(taskId));
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
}
