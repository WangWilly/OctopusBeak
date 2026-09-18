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
  automationRunHistory,
  automationSaveCredentials,
  automationSetupGuideLink,
  externalPrerequisiteById,
  loadAutomationDesktopModel,
  setCathayGmailOtpEnabled,
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
import {
  updateSpendingItemCategory,
  updateSpendingTransactionOverride,
  type SpendingLoadInput,
  type SpendingOverrideUpdate,
} from "../src/lib/spending/server/store.ts";
import type { FinancialPageLoadInput } from "../src/lib/desktop/api.ts";
import { createFinancialPageWorkerClient } from "./financial-page-worker-client.ts";
import { readAutomationSettings } from "../src/lib/automation/server/settings.ts";
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
import { openCanonicalDatabaseHandle } from "../src/ledger/canonical/canonical-database.ts";
import {
  createFinancialFreshnessBroadcaster,
  FINANCIAL_FRESHNESS_LATEST_CHANNEL,
  latestKnowledgePointFromDatabase,
} from "./financial-freshness.ts";

function cutoffFrom(value: unknown): { knowledgePoint: number } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Financial query cutoff must be an object.");
  }
  const record = value as Record<string, unknown>;
  const knowledgePoint = record.knowledgePoint;
  if (
    typeof knowledgePoint !== "number" ||
    !Number.isSafeInteger(knowledgePoint) ||
    knowledgePoint < 0 ||
    Object.keys(record).length !== 1
  ) {
    throw new TypeError(
      "Financial query cutoff must contain a non-negative safe integer knowledge point.",
    );
  }
  return Object.freeze({ knowledgePoint });
}

function financialPageLoadInputFrom(
  value: unknown,
): FinancialPageLoadInput | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Financial page load input must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "cutoff")) {
    throw new TypeError("Financial page load input contains an unknown field.");
  }
  const cutoff = cutoffFrom(record.cutoff);
  return cutoff === undefined ? {} : Object.freeze({ cutoff });
}

function spendingLoadInputFrom(value: unknown): SpendingLoadInput | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Spending load input must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) =>
    key !== "selectedMonth" && key !== "selectedCategory" && key !== "cutoff"
  )) {
    throw new TypeError("Spending load input contains an unknown field.");
  }
  if (record.selectedMonth !== undefined && typeof record.selectedMonth !== "string") {
    throw new TypeError("Spending selected month must be a string.");
  }
  if (record.selectedCategory !== undefined && typeof record.selectedCategory !== "string") {
    throw new TypeError("Spending selected category must be a string.");
  }
  const cutoff = cutoffFrom(record.cutoff);
  return {
    ...(record.selectedMonth === undefined ? {} : { selectedMonth: record.selectedMonth }),
    ...(record.selectedCategory === undefined ? {} : { selectedCategory: record.selectedCategory }),
    ...(cutoff === undefined ? {} : { cutoff }),
  } as SpendingLoadInput;
}

export function registerOctopusBeakIpc({
  onSystemSettingsChanged,
}: {
  onSystemSettingsChanged?: (
    settings: SystemSettingsDto,
  ) => void | Promise<void>;
} = {}) {
  const financialPages = createFinancialPageWorkerClient(
    new Worker(join(__dirname, "financial-page-worker.cjs")),
  );
  const financialFreshness = createFinancialFreshnessBroadcaster({
    getWindows: () => BrowserWindow.getAllWindows(),
  });
  const canonicalLedgerDir =
    process.env.OCTOPUSBEAK_CANONICAL_LEDGER_DIR ??
    process.env.LEDGER_DIR ??
    "data/ledger";
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
  ipcMain.handle("overview:load", (_event, input: unknown) =>
    financialPages.load("overview", financialPageLoadInputFrom(input)),
  );
  ipcMain.handle("assets:load", (_event, input: unknown) =>
    financialPages.load("assets", financialPageLoadInputFrom(input)),
  );
  ipcMain.handle("liabilities:load", (_event, input: unknown) =>
    financialPages.load("liabilities", financialPageLoadInputFrom(input)),
  );
  ipcMain.handle(
    "spending:load",
    (_event, input: unknown) =>
      financialPages.load("spending", spendingLoadInputFrom(input)),
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
  ipcMain.handle(FINANCIAL_FRESHNESS_LATEST_CHANNEL, () => {
    const database = openCanonicalDatabaseHandle(canonicalLedgerDir, {
      readOnly: true,
    });
    try {
      return latestKnowledgePointFromDatabase(database.db);
    } finally {
      database.close();
    }
  });
  ipcMain.handle("automation:load", () => loadAutomationDesktopModel());
  ipcMain.handle(
    "automation:saveCredentials",
    (_event, updates: Record<string, string>) =>
      automationSaveCredentials(updates),
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
    automationRun(taskId, undefined, (receipt) => {
      financialFreshness.publish(receipt);
    }),
  );
  ipcMain.handle("automation:runMany", (_event, taskIds: string[]) =>
    automationRunMany(taskIds, undefined, (receipt) => {
      financialFreshness.publish(receipt);
    }),
  );
  ipcMain.handle("automation:resume", (_event, taskId: string) =>
    automationResume(taskId, undefined, (receipt) => {
      financialFreshness.publish(receipt);
    }),
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
  return {
    close: () => financialPages.close(),
    publishCanonicalFinancialCommitReceipt: (receipt: Parameters<typeof financialFreshness.publish>[0]) =>
      financialFreshness.publish(receipt),
  };
}
