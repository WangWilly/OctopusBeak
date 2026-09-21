import {
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type OpenDialogOptions,
} from "electron";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  automationCancel,
  cathayGmailOtpStatus,
  disconnectCathayGmailOtp,
  enableCathayGmailOtp,
  automationResume,
  automationRun,
  automationRunMany,
  automationForceTerminate,
  automationRunHistory,
  automationSaveCredentials,
  automationSetupGuideLink,
  externalPrerequisiteById,
  readAutomationCredentialState,
  setCathayGmailOtpEnabled,
} from "../src/lib/automation/server/desktop-api.ts";
import {
  assertKnownAutomationRuntimeTasks,
  AutomationRuntimeInvariantError,
} from "../src/lib/automation/runtime-invariants.ts";
import { terminateAutomationTaskProcesses } from "../src/lib/automation/server/task-run-execution.ts";
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
import {
  updateSpendingItemCategory,
  updateSpendingTransactionOverride,
  type SpendingLoadInput,
  type SpendingOverrideUpdate,
} from "../src/lib/spending/server/store.ts";
import { createFinancialPageWorkerClient } from "./financial-page-worker-client.ts";
import { createAutomationCredentialStateCache } from "./automation-credential-state.ts";
import { readAutomationSettings } from "../src/lib/automation/server/settings.ts";
import { AUTOMATION_CREDENTIAL_KEYS, AUTOMATION_TASKS } from "../src/lib/automation/server/tasks.ts";
import { writeAutomationSettings } from "../src/lib/automation/server/config-files.ts";
import {
  systemSettings,
  validateSystemSettings,
  type SystemSettingsDto,
} from "../src/lib/settings/system-settings.ts";
import {
  isFiniteDisplayScale,
  trafficLightPositionForScale,
} from "./window-options.ts";
import {
  dataVersionStore,
  withExpectedDataVersion,
  type DataReadOptions,
} from "../src/lib/shared-shell/data-version.ts";
import type { DashboardBlockKey } from "../src/lib/shared-shell/block-load-state.ts";
import type { AutomationCredentialStatus } from "../src/lib/desktop/api.ts";
import { automationRuntimeState } from "../src/lib/automation/server/runtime-state.ts";

export function registerOctopusBeakIpc({
  onSystemSettingsChanged,
  onAutomationRuntimeFatal,
  onAutomationRuntimeReady,
}: {
  onSystemSettingsChanged?: (
    settings: SystemSettingsDto,
  ) => void | Promise<void>;
  onAutomationRuntimeFatal?: (details: { code: string; stage: string }) => void;
  onAutomationRuntimeReady?: () => Promise<void> | void;
} = {}) {
  const reportAutomationRuntimeFatal = (stage: string, error?: unknown): never => {
    const invariant = error instanceof AutomationRuntimeInvariantError ? error.details : null;
    const details = {
      code: invariant?.code ?? "automation-runtime-snapshot-failed",
      stage,
      ...(invariant
        ? {
          sessionId: invariant.sessionId,
          revision: invariant.revision,
          taskId: invariant.taskId,
          runId: invariant.runId,
        }
        : {}),
    };
    console.error("automation-runtime-fatal", {
      ...details,
      ...(process.env.NODE_ENV === "development" && error instanceof Error
        ? { stack: error.stack }
        : {}),
    });
    onAutomationRuntimeFatal?.(details);
    throw new Error("Automation runtime snapshot unavailable.");
  };
  const ensureAutomationRuntimeReady = async (stage: string) => {
    try {
      await onAutomationRuntimeReady?.();
    } catch (error) {
      reportAutomationRuntimeFatal(stage, error);
    }
  };
  const unsubscribeFromDataInvalidation = dataVersionStore.subscribe((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("data:invalidated", event);
    }
  });
  const unsubscribeFromAutomationRuntime = automationRuntimeState.subscribe((snapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("automation:runtime-changed", snapshot);
    }
  });
  const financialPages = createFinancialPageWorkerClient(
    new Worker(join(__dirname, "financial-page-worker.cjs")),
  );
  const automationCredentials = createAutomationCredentialStateCache(
    readAutomationCredentialState,
  );
  void automationCredentials.prewarm().catch(() => {
    // The details block reports a retryable, user-facing error if this fails.
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
  ipcMain.handle(
    "overview:load",
    (_event, options: DataReadOptions | undefined) =>
      withExpectedDataVersion(
        options?.expectedVersion,
        () => dataVersionStore.snapshot(),
        () => financialPages.load("overview", options),
      ),
  );
  ipcMain.handle(
    "overview:block",
    (_event, block: DashboardBlockKey, options: DataReadOptions | undefined) =>
      withExpectedDataVersion(
        options?.expectedVersion,
        () => dataVersionStore.snapshot(),
        () => financialPages.loadBlock("overview", block, options),
      ),
  );
  ipcMain.handle(
    "assets:load",
    (_event, options: DataReadOptions | undefined) =>
      withExpectedDataVersion(
        options?.expectedVersion,
        () => dataVersionStore.snapshot(),
        () => financialPages.load("assets", options),
      ),
  );
  ipcMain.handle(
    "assets:block",
    (_event, block: DashboardBlockKey, options: DataReadOptions | undefined) =>
      withExpectedDataVersion(
        options?.expectedVersion,
        () => dataVersionStore.snapshot(),
        () => financialPages.loadBlock("assets", block, options),
      ),
  );
  ipcMain.handle(
    "liabilities:load",
    (_event, options: DataReadOptions | undefined) =>
      withExpectedDataVersion(
        options?.expectedVersion,
        () => dataVersionStore.snapshot(),
        () => financialPages.load("liabilities", options),
      ),
  );
  ipcMain.handle(
    "liabilities:block",
    (_event, block: DashboardBlockKey, options: DataReadOptions | undefined) =>
      withExpectedDataVersion(
        options?.expectedVersion,
        () => dataVersionStore.snapshot(),
        () => financialPages.loadBlock("liabilities", block, options),
      ),
  );
  ipcMain.handle(
    "spending:load",
    (
      _event,
      input: SpendingLoadInput | undefined,
      options: DataReadOptions | undefined,
    ) =>
      withExpectedDataVersion(
        options?.expectedVersion,
        () => dataVersionStore.snapshot(),
        () => financialPages.load("spending", input, options),
      ),
  );
  ipcMain.handle(
    "spending:block",
    (_event, block: DashboardBlockKey, options: DataReadOptions | undefined) =>
      withExpectedDataVersion(
        options?.expectedVersion,
        () => dataVersionStore.snapshot(),
        () => financialPages.loadBlock("spending", block, options),
      ),
  );
  ipcMain.handle("spending:pairing-candidates", (_event, input) =>
    financialPages.rankPairingCandidates(input),
  );
  ipcMain.handle("spending:pairing-prewarm", (_event, input) =>
    financialPages.prewarmPairingCandidates(input),
  );
  ipcMain.handle("spending:confirmCandidate", (_event, input) =>
    financialPages.confirmCandidate(input),
  );
  ipcMain.handle("spending:denyCandidate", (_event, input) =>
    financialPages.denyCandidate(input),
  );
  ipcMain.handle("spending:revokeLink", (_event, input) =>
    financialPages.revokeLink(input),
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
  ipcMain.handle(
    "automation:block",
    async (_event, block: DashboardBlockKey, options: DataReadOptions | undefined) =>
      withExpectedDataVersion(
        options?.expectedVersion,
        () => dataVersionStore.snapshot(),
        async () => {
          await ensureAutomationRuntimeReady("automation-block");
          let credentialState;
          try {
            credentialState = options?.refreshCredentials
              ? await automationCredentials.refresh()
              : await automationCredentials.read();
          } catch (error) {
            if (block === "details") throw new Error("無法讀取登入資料");
            console.warn("automation-credential-state-read-failed", {
              code: "credential-state-unavailable",
              stage: "block",
              block,
              message: error instanceof Error ? error.message : "unknown",
            });
            const states: Record<string, AutomationCredentialStatus> = {};
            for (const key of AUTOMATION_CREDENTIAL_KEYS) states[key] = "read_failed";
            credentialState = {
              revision: 0,
              status: Object.fromEntries(AUTOMATION_CREDENTIAL_KEYS.map((key) => [key, false])),
              states,
              fileNames: {},
              invalidFileKeys: [],
              invalidFileReasons: {},
            };
          }
          let runtimeSnapshot;
          try {
            runtimeSnapshot = automationRuntimeState.snapshot();
            assertKnownAutomationRuntimeTasks(
              runtimeSnapshot,
              new Set(AUTOMATION_TASKS.map((task) => task.id)),
            );
          } catch (error) {
            reportAutomationRuntimeFatal("automation-block", error);
          }
          return financialPages.loadBlock(
            "automation",
            block,
            options,
            credentialState,
            runtimeSnapshot,
          );
        },
      ),
  );
  ipcMain.handle(
    "automation:saveCredentials",
    async (_event, updates: Record<string, string>) => {
      const result = automationSaveCredentials(updates);
      if (result.saved) await automationCredentials.refresh();
      return result;
    },
  );
  ipcMain.handle("automation:cathayGmailOtpStatus", () =>
    cathayGmailOtpStatus(),
  );
  ipcMain.handle("automation:enableCathayGmailOtp", () =>
    enableCathayGmailOtp(),
  );
  ipcMain.handle(
    "automation:setCathayGmailOtpEnabled",
    (_event, enabled: unknown) => {
      if (typeof enabled !== "boolean") {
        throw new TypeError("Cathay Gmail OTP enabled flag must be boolean.");
      }
      return setCathayGmailOtpEnabled(enabled);
    },
  );
  ipcMain.handle("automation:disconnectCathayGmailOtp", () =>
    disconnectCathayGmailOtp(),
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
  ipcMain.handle("automation:forceTerminate", (_event, taskId: string) =>
    automationForceTerminate(taskId),
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
  ipcMain.handle("automation:runtimeSnapshot", async () => {
    try {
      await ensureAutomationRuntimeReady("runtime-snapshot");
      return automationRuntimeState.snapshot();
    } catch (error) {
      return reportAutomationRuntimeFatal("runtime-snapshot", error);
    }
  });
  ipcMain.handle("automation:fatalRuntimeSnapshot", () => {
    reportAutomationRuntimeFatal("renderer-resync");
  });
  ipcMain.handle("data:getVersion", () => dataVersionStore.snapshot());
  ipcMain.handle("data:acknowledgeVersion", (_event, version: unknown) => {
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) {
      throw new TypeError("Data version must be a non-negative safe integer.");
    }
    dataVersionStore.acknowledge(version);
    return dataVersionStore.snapshot();
  });
  return {
    close: async () => {
      unsubscribeFromDataInvalidation();
      unsubscribeFromAutomationRuntime();
      await financialPages.close();
    },
  };
}
