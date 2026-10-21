import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from "electron";
import type { OctopusBeakApi } from "../src/lib/desktop/api.ts";
import type { OctopusBeakInvokeChannels } from "./preload.ts";
import {
  automationRunHistory,
  automationSaveCredentials,
  automationSetupGuideLink,
  applyAutomationCredentialState,
  loadAutomationCoreSnapshot,
  externalPrerequisiteById,
  readAutomationCredentialState,
} from "../src/lib/automation/server/desktop-api.ts";
import {
  assertKnownAutomationRuntimeTasks,
  automationRuntimeFatalDetails,
} from "../src/lib/automation/runtime-invariants.ts";
import {
  cancelDeviceRegistration,
  deviceRegistrationStatus,
  startDeviceRegistration,
  submitDeviceRegistrationCode,
} from "../src/lib/automation/server/device-registration-host.ts";
import {
  deviceRegistrationSource,
  type DeviceRegistrationSource,
} from "../src/lib/automation/types.ts";
import {
  CERTIFICATE_FILE_EXTENSIONS,
  validateCertificateFilePath,
} from "../src/lib/automation/server/credential-file.ts";
import type { SpendingLoadInput } from "../src/lib/spending/contracts.ts";
import {
  registerPGliteViewIpc,
  type PGliteViewIpcRegistration,
} from "./pglite-ipc.ts";
import { createAutomationCredentialStateCache } from "./automation-credential-state.ts";
import { displayScaleZoomFactor } from "../src/lib/settings/display-zoom.ts";
import { currentPreviewVisibility, readAutomationSettings } from "../src/lib/automation/server/settings.ts";
import { sameVisibility } from "../src/lib/preview-sources/visibility.ts";
import { AUTOMATION_CREDENTIAL_KEYS, AUTOMATION_TASKS } from "../src/lib/automation/server/tasks.ts";
import { writeAutomationSettings } from "../src/lib/automation/server/config-files.ts";
import { takeSignInSettingsRequest } from "./sign-in-settings-request.ts";
import { deleteAllPreviewData } from "../src/lib/preview-sources/delete-preview-data.ts";
import {
  previewSourceForTask,
  previewStructureReportIssueUrl,
  previewStructureReports,
  renderPreviewStructureReport,
} from "../src/lib/preview-sources/structure-report.ts";
import type { PGlitePreviewFinancialDataPort } from "../src/ledger/pglite/preview-financial-data.ts";
import {
  systemSettings,
  systemSettingsFileEntries,
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
import { projectAutomationBlock } from "./automation-block.ts";
import type { AutomationCredentialStatus } from "../src/lib/desktop/api.ts";
import type { AutomationRuntime } from "../src/lib/automation/server/automation-runtime.ts";
import type { AutomationPersistenceProvider } from "../src/lib/automation/server/store.ts";
import type { ExchangeRatePersistencePort } from "../src/ledger/exchange-rates.ts";
import type { PGliteViewWorkerClient } from "./pglite-view-worker-client.ts";
import {
  prewarmPGlitePairingCandidates,
  type PGliteFinancialPort,
} from "./pglite-financial-registry.ts";
import type {
  SpendingCandidatePageRequest,
  SpendingPageActionRequest,
  SpendingPurchaseCategoryRequest,
  SpendingRecordPageRequest,
  SpendingMergeLogRequest,
  SpendingMerchantStatsRequest,
  SpendingMonthInsightRequest,
  SpendingPendingOverviewRequest,
  SpendingStrongConfirmRequest,
} from "../src/lib/spending/model.ts";


type InvokeChannel = {
  [Namespace in keyof OctopusBeakInvokeChannels]: OctopusBeakInvokeChannels[Namespace][keyof OctopusBeakInvokeChannels[Namespace]];
}[keyof OctopusBeakInvokeChannels];

type BridgeMethod<Channel extends InvokeChannel> = {
  [Namespace in keyof OctopusBeakInvokeChannels]: {
    [Method in keyof OctopusBeakInvokeChannels[Namespace]]: OctopusBeakInvokeChannels[Namespace][Method] extends Channel
      ? OctopusBeakApi[Namespace][Method & keyof OctopusBeakApi[Namespace]]
      : never;
  }[keyof OctopusBeakInvokeChannels[Namespace]];
}[keyof OctopusBeakInvokeChannels];

/** One main-process handler per preload channel, returning what the bridge method promises. */
type OctopusBeakInvokeHandlers = {
  [Channel in InvokeChannel]: BridgeMethod<Channel> extends (...args: infer Args) => infer Result
    ? (event: IpcMainInvokeEvent, ...args: Args) => Result | Awaited<Result>
    : never;
};

const REGISTRATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ONE_TIME_CODE = /^[0-9]{4,8}$/u;

function registrationSource(value: unknown): DeviceRegistrationSource {
  const source = typeof value === "string" ? deviceRegistrationSource(value) : null;
  if (!source) throw new TypeError("Device registration source is invalid.");
  return source;
}

function registrationId(value: unknown): string {
  if (typeof value !== "string" || !REGISTRATION_ID.test(value)) {
    throw new TypeError("Device registration ID is invalid.");
  }
  return value;
}

export function registerOctopusBeakIpc({
  automationRuntime,
  onSystemSettingsChanged,
  onAutomationRuntimeFatal,
  onAutomationRuntimeReady,
  pgliteViews,
  pgliteOperational,
  pgliteFinancial,
}: {
  automationRuntime: AutomationRuntime;
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
  const reportAutomationRuntimeFatal = (stage: string, error?: unknown): never => {
    const details = automationRuntimeFatalDetails(stage, error);
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
  const unsubscribeFromDataInvalidation = dataVersionStore.subscribe((event) => {
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) window.webContents.send("data:invalidated", event);
    }
  });
  const unsubscribeFromAutomationRuntime = automationRuntime.subscribe((snapshot) => {
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
    if (!isFiniteDisplayScale(percent)) return;
    event.sender.setZoomFactor(displayScaleZoomFactor(percent));
    if (process.platform !== "darwin") return;
    BrowserWindow.fromWebContents(event.sender)?.setWindowButtonPosition(
      trafficLightPositionForScale(percent),
    );
  });
  function markStaleWhenPreviewVisibilityChanges<T>(write: () => T): T {
    const before = currentPreviewVisibility();
    const result = write();
    if (!sameVisibility(currentPreviewVisibility(), before)) {
      dataVersionStore.markStale("preview-data-changed");
      void financialPages.request("financial.preview.visibilityChanged", [])
        .catch((error) => console.error("preview-visibility-refresh-failed", error));
    }
    return result;
  }
  const invokeHandlers: OctopusBeakInvokeHandlers = {
    "settings:load": () =>
      systemSettings(readAutomationSettings()),
    "settings:save": async (_event, input: SystemSettingsDto) => {
      const value = validateSystemSettings(input);
      markStaleWhenPreviewVisibilityChanges(() => writeAutomationSettings({
        ...readAutomationSettings(),
        ...systemSettingsFileEntries(value),
      }));
      await onSystemSettingsChanged?.(value);
      return value;
    },
    "settings:deletePreviewData": () =>
      deleteAllPreviewData(operationalProvider.preview, dataVersionStore),
    "spending:record-page": async (_event, request: SpendingRecordPageRequest) => {
      return pgliteFinancial.request("financial.spending.recordPage", [request]);
    },
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
    "spending:page-action": async (_event, request: SpendingPageActionRequest) => {
      return pgliteFinancial.request("financial.spending.pageAction", [request]);
    },
    "spending:set-purchase-category": async (_event, request: SpendingPurchaseCategoryRequest) => {
      return pgliteFinancial.request("financial.spending.setPurchaseCategory", [request]);
    },
    "spending:pending-overview": async (_event, request: SpendingPendingOverviewRequest) => {
      return pgliteFinancial.request("financial.spending.pendingOverview", [request]);
    },
    "spending:merge-log": async (_event, request: SpendingMergeLogRequest) => {
      return pgliteFinancial.request("financial.spending.mergeLog", [request]);
    },
    "spending:month-insight": async (_event, request: SpendingMonthInsightRequest) => {
      return pgliteFinancial.request("financial.spending.monthInsight", [request]);
    },
    "spending:merchant-stats": async (_event, request: SpendingMerchantStatsRequest) => {
      return pgliteFinancial.request("financial.spending.merchantStats", [request]);
    },
    "spending:confirm-strong-candidates": async (_event, request: SpendingStrongConfirmRequest) => {
      return pgliteFinancial.request("financial.spending.confirmStrongCandidates", [request]);
    },
    "spending:pairing-candidates": (_event, input) =>
      financialPages.request("financial.spending.pairing", [input]),
    "spending:pairing-prewarm": (_event, input) =>
      prewarmPGlitePairingCandidates(financialPages, input),
    "spending:confirmCandidate": (_event, input) =>
      financialPages.request("financial.spending.confirmCandidate", [input]),
    "spending:denyCandidate": (_event, input) =>
      financialPages.request("financial.spending.denyCandidate", [input]),
    "spending:revokeLink": (_event, input) =>
      financialPages.request("financial.spending.revokeLink", [input]),
    "automation:block": async (_event, block: DashboardBlockKey, options: DataReadOptions | undefined) =>
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
              runtimeSnapshot = automationRuntime.snapshot();
              assertKnownAutomationRuntimeTasks(
                runtimeSnapshot,
                new Set(AUTOMATION_TASKS.map((task) => task.id)),
              );
            } catch (error) {
              reportAutomationRuntimeFatal("automation-block", error);
            }
            const core = await loadAutomationCoreSnapshot(
              operationalProvider,
              { snapshot: runtimeSnapshot!, activeTaskIds: automationRuntime.activeTaskIds() },
              credentialState.status,
              credentialState.states,
            );
            const model = credentialState
              ? applyAutomationCredentialState(core, credentialState)
              : core;
            return projectAutomationBlock(model, block);
          },
        ),
    "automation:saveCredentials": async (_event, updates: Record<string, string>) => {
        const result = markStaleWhenPreviewVisibilityChanges(() => automationSaveCredentials(updates));
        if (result.saved) await automationCredentials.refresh();
        return result;
      },
    "automation:deviceRegistrationStatus": (_event, source: unknown) => deviceRegistrationStatus(registrationSource(source)),
    "automation:startDeviceRegistration": (_event, source: unknown) => startDeviceRegistration(registrationSource(source)),
    "automation:submitDeviceRegistrationCode": (_event, source: unknown, id: unknown, code: unknown) => {
        const validSource = registrationSource(source);
        const validId = registrationId(id);
        if (typeof code !== "string" || !ONE_TIME_CODE.test(code)) {
          throw new TypeError("A one-time code must be 4 to 8 digits.");
        }
        return submitDeviceRegistrationCode(validSource, validId, code);
      },
    "automation:cancelDeviceRegistration": (_event, source: unknown, id: unknown) => {
        cancelDeviceRegistration(registrationSource(source), registrationId(id));
      },
    "automation:selectCertificateFile": async (event, locale: "en" | "zh-TW") => {
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
    "automation:openSetupGuideLink": async (_event, groupId: string, linkId: string, locale: "en" | "zh-TW") => {
        const guideLink = automationSetupGuideLink(groupId, linkId, locale);
        if (!guideLink) throw new Error("Unknown or unsafe setup guide link.");
        await shell.openExternal(guideLink.url);
        return { ok: true as const };
      },
    "automation:run": async (_event, taskId: string) => {
      await ensureAutomationRuntimeReady("automation-run");
      return automationRuntime.run(taskId);
    },
    "automation:runMany": async (_event, taskIds: string[]) => {
      await ensureAutomationRuntimeReady("automation-run-many");
      return automationRuntime.runMany(taskIds);
    },
    "automation:cancel": (_event, taskId: string, expectedRunId?: string) =>
      automationRuntime.cancel(taskId, expectedRunId),
    "automation:forceTerminate": (_event, taskId: string, expectedRunId?: string) =>
      automationRuntime.forceTerminate(taskId, expectedRunId),
    "automation:runHistory": () => automationRunHistory(operationalProvider),
    "automation:takeSignInSettingsRequest": () => takeSignInSettingsRequest(),
    "automation:previewStructureReport": (_event, taskId: string) => {
      const report = previewStructureReports.get(taskId);
      return report ? renderPreviewStructureReport(report, app.getVersion()) : null;
    },
    "automation:openPreviewStructureReportIssue": async (_event, taskId: string) => {
      const source = previewSourceForTask(taskId);
      if (!source || !previewStructureReports.get(taskId)) throw new Error("No preview structure report for this task.");
      await shell.openExternal(previewStructureReportIssueUrl(source));
      return { ok: true as const };
    },
    "automation:openExternalPrerequisite": async (_event, prerequisiteId: string) => {
        const prerequisite = externalPrerequisiteById(prerequisiteId);
        if (!prerequisite)
          throw new Error("Unknown or unsafe external prerequisite.");
        await shell.openExternal(prerequisite.downloadUrl);
        return { ok: true as const };
      },
    "automation:runtimeSnapshot": async () => {
      try {
        await ensureAutomationRuntimeReady("runtime-snapshot");
        return automationRuntime.snapshot();
      } catch (error) {
        return reportAutomationRuntimeFatal("runtime-snapshot", error);
      }
    },
    "automation:fatalRuntimeSnapshot": () => {
      reportAutomationRuntimeFatal("renderer-resync");
    },
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
      unsubscribeFromAutomationRuntime();
      await pgliteViewRegistration.close();
    },
  };
}
