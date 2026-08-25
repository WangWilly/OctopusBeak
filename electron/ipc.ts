import {
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type OpenDialogOptions,
} from "electron";
import { createDataIssueIpcHandlers } from "../src/lib/desktop/api.ts";
import { loadAssets } from "../src/lib/assets/server/load-assets.ts";
import {
  automationCancel,
  automationResume,
  automationRun,
  automationRunMany,
  automationRunHistory,
  automationSaveCredentials,
  automationSetupGuideLink,
  externalPrerequisiteById,
  loadAutomationDesktopModel,
} from "../src/lib/automation/server/desktop-api.ts";
import {
  CERTIFICATE_FILE_EXTENSIONS,
  validateCertificateFilePath,
} from "../src/lib/automation/server/credential-file.ts";
import {
  captureSessionScreenshot,
  isClosedViewerSessionError,
  inspectHumanVerificationPoint,
} from "../src/lib/automation/server/automation-viewer.ts";
import {
  inspectProviderVerificationCompletion,
  refreshProviderVerificationTarget,
  sendProviderVerificationInput,
  shouldAutoResumeProviderVerification,
  shouldCheckProviderVerificationCompletion,
  waitForProviderVerificationCompletion,
} from "../src/lib/automation/server/provider-verification.ts";
import {
  forceQuitHumanSessionForTask,
  humanAssistanceContractForTask,
  humanSessionForTask,
  updateHumanAssistanceContractForTask,
  updateHumanAssistanceCompletionForTask,
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
import { readAutomationSettings } from "../src/lib/automation/server/settings.ts";
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
import {
  isFiniteDisplayScale,
  trafficLightPositionForScale,
} from "./window-options.ts";

export function registerOctopusBeakIpc({
  onSystemSettingsChanged,
}: {
  onSystemSettingsChanged?: (
    settings: SystemSettingsDto,
  ) => void | Promise<void>;
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
  ipcMain.handle("settings:load", () =>
    systemSettings(readAutomationSettings()),
  );
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
  ipcMain.handle(
    "spending:load",
    (_event, input: SpendingLoadInput | undefined) =>
      loadSpending(undefined, input),
  );
  ipcMain.handle("spending:updateItemCategory", async (_event, input) => {
    await updateSpendingItemCategory(input);
    return { ok: true as const };
  });
  ipcMain.handle(
    "spending:updateTransactionOverride",
    (_event, input: SpendingOverrideUpdate) => {
      updateSpendingTransactionOverride(input);
      return { ok: true as const };
    },
  );
  ipcMain.handle("automation:load", () => loadAutomationDesktopModel());
  ipcMain.handle(
    "automation:saveCredentials",
    (_event, updates: Record<string, string>) =>
      automationSaveCredentials(updates),
  );
  ipcMain.handle(
    "automation:selectCertificateFile",
    async (event, locale: "en" | "zh-TW") => {
      const chinese = locale === "zh-TW";
      const options: OpenDialogOptions = {
        title: chinese ? "選擇憑證檔案" : "Choose certificate file",
        properties: ["openFile"],
        filters: [
          {
            name: chinese ? "憑證檔案" : "Certificate files",
            extensions: [...CERTIFICATE_FILE_EXTENSIONS],
          },
        ],
      };
      const owner = BrowserWindow.fromWebContents(event.sender);
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths[0])
        return { cancelled: true as const };
      const validation = validateCertificateFilePath(result.filePaths[0]);
      if (!validation.valid)
        return { cancelled: false as const, error: validation.reason };
      return {
        cancelled: false as const,
        path: validation.path,
        filename: validation.filename,
      };
    },
  );
  ipcMain.handle(
    "automation:openSetupGuideLink",
    async (_event, groupId: string, linkId: string, locale: "en" | "zh-TW") => {
      const guideLink = automationSetupGuideLink(groupId, linkId, locale);
      if (!guideLink) throw new Error("Unknown or unsafe setup guide link.");
      await shell.openExternal(guideLink.url);
      return { ok: true as const };
    },
  );
  ipcMain.handle("automation:run", (_event, taskId: string) =>
    automationRun(taskId),
  );
  ipcMain.handle("automation:runMany", (_event, taskIds: string[]) =>
    automationRunMany(taskIds),
  );
  ipcMain.handle("automation:resume", (_event, taskId: string) =>
    automationResume(taskId),
  );
  ipcMain.handle("automation:cancel", (_event, taskId: string) =>
    automationCancel(taskId),
  );
  ipcMain.handle("automation:runHistory", () => automationRunHistory());
  ipcMain.handle(
    "automation:openExternalPrerequisite",
    async (_event, prerequisiteId: string) => {
      const prerequisite = externalPrerequisiteById(prerequisiteId);
      if (!prerequisite)
        throw new Error("Unknown or unsafe external prerequisite.");
      await shell.openExternal(prerequisite.downloadUrl);
      return { ok: true as const };
    },
  );
  ipcMain.handle(
    "automation:viewerScreenshot",
    async (_event, taskId: string) => {
      const session = humanSessionForTask(taskId);
      try {
        return new Uint8Array(await captureSessionScreenshot(session));
      } catch (error) {
        if (isClosedViewerSessionError(error)) return null;
        throw error;
      }
    },
  );
  ipcMain.handle(
    "automation:viewerInspect",
    async (_event, taskId: string, point: unknown) => {
      const session = humanSessionForTask(taskId);
      const contract = humanAssistanceContractForTask(taskId);
      if (!contract)
        throw new Error(
          "Human assistance contract is missing; force quit this legacy run.",
        );
      const refreshedContractInput =
        await refreshProviderVerificationTarget(session, contract);
      const refreshedContract = refreshedContractInput
        ? updateHumanAssistanceContractForTask(taskId, refreshedContractInput)
        : contract;
      return inspectHumanVerificationPoint(session, point, refreshedContract);
    },
  );
  ipcMain.handle(
    "automation:viewerInput",
    async (_event, taskId: string, input: unknown) => {
      const session = humanSessionForTask(taskId);
      const contract = humanAssistanceContractForTask(taskId);
      if (!contract)
        throw new Error(
          "Human assistance contract is missing; force quit this legacy run.",
        );
      const refreshedContractInput =
        await refreshProviderVerificationTarget(session, contract);
      const refreshedContract = refreshedContractInput
        ? updateHumanAssistanceContractForTask(taskId, refreshedContractInput)
        : contract;
      await sendProviderVerificationInput(session, input, refreshedContract);
      const refreshedContractInputAfterInput =
        await refreshProviderVerificationTarget(
          session,
          refreshedContract,
        );
      const refreshedContractAfterInput = refreshedContractInputAfterInput
        ? updateHumanAssistanceContractForTask(
            taskId,
            refreshedContractInputAfterInput,
          )
          : refreshedContract;
      const record =
        input && typeof input === "object"
          ? (input as Record<string, unknown>)
          : {};
      const clickedTarget =
        typeof record.targetId === "string"
          ? refreshedContractAfterInput.targets.find(
              (target) => target.id === record.targetId,
            )
          : undefined;
      const shouldCheckCompletion = shouldCheckProviderVerificationCompletion(
        record.type,
        clickedTarget?.semanticId,
      );
      const verified =
        shouldCheckCompletion &&
        (await waitForProviderVerificationCompletion(
          session,
          refreshedContractAfterInput,
        ));
      const isTextInputOnCompletionTarget =
        record.type === "type" &&
        refreshedContractAfterInput.completion.mode === "inline" &&
        typeof record.targetId === "string" &&
        refreshedContractAfterInput.completion.targetIds.includes(record.targetId);
      const updatedContract = verified
        ? updateHumanAssistanceCompletionForTask(taskId, "verified")
        : isTextInputOnCompletionTarget
          ? updateHumanAssistanceCompletionForTask(taskId, "entered")
          : refreshedContractAfterInput;
      const resumed =
        typeof record.targetId === "string" &&
        shouldAutoResumeProviderVerification(
          updatedContract,
          record.targetId,
          verified,
        );
      if (resumed) automationResume(taskId);
      return { ok: true as const, contract: updatedContract, resumed };
    },
  );
  ipcMain.handle(
    "automation:viewerCompletionCheck",
    async (_event, taskId: string) => {
      const session = humanSessionForTask(taskId);
      const contract = humanAssistanceContractForTask(taskId);
      if (!contract)
        throw new Error(
          "Human assistance contract is missing; force quit this legacy run.",
        );
      const refreshedContractInput =
        await refreshProviderVerificationTarget(session, contract);
      const refreshedContract = refreshedContractInput
        ? updateHumanAssistanceContractForTask(taskId, refreshedContractInput)
        : contract;
      const verified = await inspectProviderVerificationCompletion(
        session,
        refreshedContract,
      );
      const updatedContract = verified
        ? updateHumanAssistanceCompletionForTask(taskId, "verified")
        : refreshedContract;
      return { verified, contract: updatedContract };
    },
  );
  ipcMain.handle("automation:forceQuit", async (_event, taskId: string) => {
    await forceQuitHumanSessionForTask(taskId);
    return { ok: true as const, closed: true };
  });
  ipcMain.handle("dataIssues:list", dataIssueHandlers.list);
  ipcMain.handle("dataIssues:create", dataIssueHandlers.create);
  ipcMain.handle("dataIssues:load", dataIssueHandlers.load);
  ipcMain.handle("dataIssues:startDiagnosis", dataIssueHandlers.startDiagnosis);
  ipcMain.handle(
    "dataIssues:previewExclusion",
    dataIssueHandlers.previewExclusion,
  );
  ipcMain.handle(
    "dataIssues:confirmExclusion",
    dataIssueHandlers.confirmExclusion,
  );
  ipcMain.handle("dataIssues:previewRestore", dataIssueHandlers.previewRestore);
  ipcMain.handle("dataIssues:confirmRestore", dataIssueHandlers.confirmRestore);
}
