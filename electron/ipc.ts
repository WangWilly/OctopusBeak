import {
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type OpenDialogOptions,
} from "electron";
import {
  automationCancel,
  cathayGmailOtpStatus,
  disconnectCathayGmailOtp,
  enableCathayGmailOtp,
  automationResumeHumanAssistance,
  automationRun,
  automationRunMany,
  automationForceTerminate,
  automationRunHistory,
  automationSaveCredentials,
  automationSetupGuideLink,
  applyAutomationCredentialState,
  loadAutomationCoreSnapshot,
  assertManualVerificationAllowedForTask,
  externalPrerequisiteById,
  readAutomationCredentialState,
  setCathayGmailOtpEnabled,
} from "../src/lib/automation/server/desktop-api.ts";
import {
  assertKnownAutomationRuntimeTasks,
  AutomationRuntimeInvariantError,
} from "../src/lib/automation/runtime-invariants.ts";
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
  humanAssistanceContractForTask,
  humanSessionForTask,
  updateHumanAssistanceContractForTask,
  updateHumanAssistanceCompletionForTask,
} from "../src/lib/automation/server/human-session.ts";
import type { SpendingLoadInput } from "../src/lib/spending/contracts.ts";
import {
  registerPGliteViewIpc,
  type PGliteViewIpcRegistration,
} from "./pglite-ipc.ts";
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
import type { AutomationPersistenceProvider } from "../src/lib/automation/server/store.ts";
import type { ExchangeRatePersistencePort } from "../src/ledger/exchange-rates.ts";
import type { PGliteViewWorkerClient } from "./pglite-view-worker-client.ts";
import type { PGliteFinancialPageClient } from "./pglite-financial-registry.ts";
import type {
  SpendingCandidatePageRequest,
  SpendingPageActionRequest,
  SpendingRecordPageRequest,
} from "../src/lib/spending/model.ts";
import { projectFinancialBlock } from "./financial-page-block-loader.ts";

export function registerOctopusBeakIpc({
  onSystemSettingsChanged,
  onAutomationRuntimeFatal,
  onAutomationRuntimeReady,
  pgliteViews,
  pgliteOperational,
  pgliteFinancial,
}: {
  onSystemSettingsChanged?: (
    settings: SystemSettingsDto,
  ) => void | Promise<void>;
  onAutomationRuntimeFatal?: (details: { code: string; stage: string }) => void;
  onAutomationRuntimeReady?: () => Promise<void> | void;
  pgliteViews: {
    dataDir?: string;
    workerPath?: string;
  };
  pgliteOperational: {
    provider: AutomationPersistenceProvider & { exchangeRates: ExchangeRatePersistencePort };
    worker?: Pick<PGliteViewWorkerClient, "subscribe" | "onError" | "close">;
    dataDir?: string;
    workerPath?: string;
  };
  pgliteFinancial: PGliteFinancialPageClient;
}) {
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
  const operationalProvider = pgliteOperational.provider;
  const readHumanSession = (taskId: string): Promise<string> =>
    humanSessionForTask(taskId, operationalProvider);
  const readHumanContract = (taskId: string): Promise<Awaited<ReturnType<typeof humanAssistanceContractForTask>>> =>
    humanAssistanceContractForTask(taskId, operationalProvider);
  const updateHumanContract = (
    taskId: string,
    input: Parameters<typeof updateHumanAssistanceContractForTask>[1],
  ): Promise<Awaited<ReturnType<typeof updateHumanAssistanceContractForTask>>> =>
    updateHumanAssistanceContractForTask(taskId, input, operationalProvider);
  const updateHumanCompletion = (
    taskId: string,
    status: Parameters<typeof updateHumanAssistanceCompletionForTask>[1],
  ): Promise<Awaited<ReturnType<typeof updateHumanAssistanceCompletionForTask>>> =>
    updateHumanAssistanceCompletionForTask(taskId, status, operationalProvider);
  const unsubscribeFromDataInvalidation = dataVersionStore.subscribe((event) => {
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) window.webContents.send("data:invalidated", event);
    }
  });
  const unsubscribeFromAutomationRuntime = automationRuntimeState.subscribe((snapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("automation:runtime-changed", snapshot);
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
  ipcMain.handle("spending:record-page", async (_event, request: SpendingRecordPageRequest) => {
    return pgliteFinancial.loadSpendingRecordPage(request);
  });
  ipcMain.handle("spending:candidate-page", async (_event, request: SpendingCandidatePageRequest, requestId: string) => {
    if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 160)
      throw new TypeError("Spending candidate page request id is invalid.");
    if (spendingCandidatePageControllers.has(requestId))
      throw new Error("Spending candidate page request id is already active.");
    const controller = new AbortController();
    spendingCandidatePageControllers.set(requestId, controller);
    try {
      return await pgliteFinancial.loadSpendingCandidatePage(request, { signal: controller.signal });
    } finally {
      if (spendingCandidatePageControllers.get(requestId) === controller)
        spendingCandidatePageControllers.delete(requestId);
    }
  });
  ipcMain.handle("spending:candidate-page-cancel", (_event, requestId: string) => {
    if (typeof requestId !== "string") return false;
    const controller = spendingCandidatePageControllers.get(requestId);
    if (!controller) return false;
    controller.abort();
    return true;
  });
  ipcMain.handle("spending:page-action", async (_event, request: SpendingPageActionRequest) => {
    return pgliteFinancial.applySpendingPageAction(request);
  });
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
          const core = await loadAutomationCoreSnapshot(
            operationalProvider,
            credentialState.status,
            runtimeSnapshot,
            credentialState.states,
          );
          const model = credentialState
            ? applyAutomationCredentialState(core, credentialState)
            : core;
          return projectFinancialBlock(model, block as never, "automation" as never);
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
  ipcMain.handle("automation:run", async (_event, taskId: string) => {
    await ensureAutomationRuntimeReady("automation-run");
    return automationRun(taskId, operationalProvider);
  });
  ipcMain.handle("automation:runMany", async (_event, taskIds: string[]) => {
    await ensureAutomationRuntimeReady("automation-run-many");
    return automationRunMany(taskIds, operationalProvider);
  });
  ipcMain.handle("automation:resumeHumanAssistance", async (_event, taskId: string) => {
    assertManualVerificationAllowedForTask(taskId);
    await ensureAutomationRuntimeReady("automation-resume");
    return automationResumeHumanAssistance(taskId, operationalProvider);
  });
  ipcMain.handle("automation:cancel", (_event, taskId: string, expectedRunId?: string) =>
    automationCancel(taskId, operationalProvider, expectedRunId),
  );
  ipcMain.handle("automation:forceTerminate", (_event, taskId: string, expectedRunId?: string) =>
    automationForceTerminate(taskId, operationalProvider, expectedRunId),
  );
  ipcMain.handle("automation:runHistory", () => automationRunHistory(operationalProvider));
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
      assertManualVerificationAllowedForTask(taskId);
      const session = await readHumanSession(taskId);
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
      assertManualVerificationAllowedForTask(taskId);
      const session = await readHumanSession(taskId);
      const contract = await readHumanContract(taskId);
      if (!contract)
        throw new Error(
          "Human assistance contract is missing for this run; force quit it.",
        );
      const refreshedContractInput =
        await refreshProviderVerificationTarget(session, contract);
      const refreshedContract = refreshedContractInput
        ? await updateHumanContract(taskId, refreshedContractInput)
        : contract;
      return inspectHumanVerificationPoint(session, point, refreshedContract);
    },
  );
  ipcMain.handle(
    "automation:viewerInput",
    async (_event, taskId: string, input: unknown) => {
      assertManualVerificationAllowedForTask(taskId);
      const session = await readHumanSession(taskId);
      const contract = await readHumanContract(taskId);
      if (!contract)
        throw new Error(
          "Human assistance contract is missing for this run; force quit it.",
        );
      const refreshedContractInput =
        await refreshProviderVerificationTarget(session, contract);
      const refreshedContract = refreshedContractInput
        ? await updateHumanContract(taskId, refreshedContractInput)
        : contract;
      await sendProviderVerificationInput(session, input, refreshedContract);
      const refreshedContractInputAfterInput =
        await refreshProviderVerificationTarget(
          session,
          refreshedContract,
        );
      const refreshedContractAfterInput = refreshedContractInputAfterInput
        ? await updateHumanContract(
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
        ? await updateHumanCompletion(taskId, "verified")
        : isTextInputOnCompletionTarget
          ? await updateHumanCompletion(taskId, "entered")
          : refreshedContractAfterInput;
      const resumed =
        typeof record.targetId === "string" &&
        shouldAutoResumeProviderVerification(
          updatedContract,
          record.targetId,
          verified,
        );
      if (resumed) {
        await ensureAutomationRuntimeReady("automation-resume");
        await automationResumeHumanAssistance(taskId, operationalProvider);
      }
      return { ok: true as const, contract: updatedContract, resumed };
    },
  );
  ipcMain.handle(
    "automation:viewerCompletionCheck",
    async (_event, taskId: string) => {
      assertManualVerificationAllowedForTask(taskId);
      const session = await readHumanSession(taskId);
      const contract = await readHumanContract(taskId);
      if (!contract)
        throw new Error(
          "Human assistance contract is missing for this run; force quit it.",
        );
      const refreshedContractInput =
        await refreshProviderVerificationTarget(session, contract);
      const refreshedContract = refreshedContractInput
        ? await updateHumanContract(taskId, refreshedContractInput)
        : contract;
      const verified = await inspectProviderVerificationCompletion(
        session,
        refreshedContract,
      );
      const updatedContract = verified
        ? await updateHumanCompletion(taskId, "verified")
        : refreshedContract;
      return { verified, contract: updatedContract };
    },
  );
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
      await pgliteViewRegistration.close();
    },
  };
}
