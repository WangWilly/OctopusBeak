import type {
  AutomationCredentialStateDto,
  AutomationCredentialStatus,
  AutomationRuntimeSnapshot,
  NotificationTarget,
} from "../../desktop/api.ts";
import {
  deviceRegistrationSource,
  type DeviceRegistrationSource,
  type DeviceRegistrationStatus,
  type DeviceRegistrationStep,
} from "../types.ts";
import {
  assertKnownAutomationRuntimeTasks,
  automationRuntimeFatalDetails,
} from "../runtime-invariants.ts";
import { isValidExternalPrerequisiteMetadata } from "../external-prerequisite.ts";
import { isStatementSelectionGroup, selectStatementTypes } from "../statement-selection.ts";
import type { AutomationRuntime } from "./automation-runtime.ts";
import {
  applyAutomationCredentialState,
  CERTIFICATE_FILE_CREDENTIAL_KEYS,
  loadAutomationCoreSnapshot,
} from "./automation-desktop-model.ts";
import {
  AUTOMATION_CREDENTIALS_PATH,
  getAutomationCredentialCodec,
  readAutomationCredentialsFile,
  splitAutomationUpdates,
  writeAutomationConfigFiles,
} from "./config-files.ts";
import {
  CERTIFICATE_FILE_EXTENSIONS,
  validateCertificateFilePath,
} from "./credential-file.ts";
import { isSourceTask, runAndSummarize, type CollectionResult } from "./collection-summary.ts";
import { scheduledCollectionTaskIds } from "./scheduled-collection.ts";
import { readAutomationSettings } from "./settings.ts";
import type { eraseSignInDetails } from "./sign-in-erasure.ts";
import type { AutomationPersistenceProvider, AutomationTaskHistoryRow } from "./store.ts";
import {
  AUTOMATION_CREDENTIAL_GROUPS,
  AUTOMATION_CREDENTIAL_KEYS,
  AUTOMATION_TASKS,
} from "./tasks.ts";
import {
  previewSourceForTask,
  previewStructureReportIssueUrl,
  renderPreviewStructureReport,
  type PreviewStructureReport,
} from "../../preview-sources/structure-report.ts";
import { clearAllSignInData, type CollectionControl } from "../../settings/data-erasure.ts";
import type { DashboardBlockKey } from "../../shared-shell/block-load-state.ts";
import {
  withExpectedDataVersion,
  type DataReadOptions,
  type DataVersionStore,
} from "../../shared-shell/data-version.ts";
import { projectAutomationBlock } from "../../../../electron/automation-block.ts";
import {
  createAutomationCredentialStateCache,
  type AutomationCredentialStateSource,
} from "../../../../electron/automation-credential-state.ts";

const REGISTRATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ONE_TIME_CODE = /^[0-9]{4,8}$/u;

const CERTIFICATE_DIALOG_COPY = {
  en: { title: "Choose certificate file", filter: "Certificate files" },
  "zh-TW": { title: "選擇憑證檔案", filter: "憑證檔案" },
} as const;

type Locale = "en" | "zh-TW";

/** What the service asks the host's file dialog for; Electron's open dialog accepts it as is. */
export type CertificateFileChooserOptions = {
  title: string;
  properties: Array<"openFile">;
  filters: Array<{ name: string; extensions: string[] }>;
};

export type FileChooserResult = Readonly<{ canceled: boolean; filePaths: readonly string[] }>;

export type AutomationDesktopLog = Readonly<{
  error(event: string, details: Readonly<Record<string, unknown>>): void;
  warn(event: string, details: Readonly<Record<string, unknown>>): void;
}>;

/**
 * Everything the automation desktop service reaches outside itself. `Owner`
 * is whatever the host's file dialog anchors to; the service only hands it back.
 */
export type AutomationDesktopServiceDeps<Owner> = Readonly<{
  runtime: AutomationRuntime;
  provider: AutomationPersistenceProvider;
  dataVersions: Pick<DataVersionStore, "snapshot" | "markStale">;
  collection: CollectionControl;
  /** Main-process credential reader behind the service's credential state cache. */
  readCredentialState(): AutomationCredentialStateSource | Promise<AutomationCredentialStateSource>;
  deviceRegistration: Readonly<{
    status(source: DeviceRegistrationSource): DeviceRegistrationStatus;
    start(source: DeviceRegistrationSource): Promise<DeviceRegistrationStep>;
    submitCode(source: DeviceRegistrationSource, registrationId: string, code: string): Promise<DeviceRegistrationStep>;
    cancel(source: DeviceRegistrationSource, registrationId: string): void;
    cancelAll(): Promise<unknown>;
  }>;
  structureReports: Readonly<{ get(taskId: string): PreviewStructureReport | null }>;
  notificationTarget: Readonly<{ take(): NotificationTarget | null }>;
  /** Receives the sources of a sync the person started, once they have all ended. */
  onManualCollectionFinished?: (results: CollectionResult[]) => void;
  eraseSignInDetails: typeof eraseSignInDetails;
  userDataDirectory(): string;
  chooseFile(owner: Owner, options: CertificateFileChooserOptions): Promise<FileChooserResult>;
  openExternal(url: string): Promise<void>;
  appVersion(): string;
  publishRuntimeChanged(snapshot: AutomationRuntimeSnapshot): void;
  onAutomationRuntimeReady?: () => Promise<void> | void;
  onAutomationRuntimeFatal?: (details: { code: string; stage: string }) => void;
  log?: AutomationDesktopLog;
}>;

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

/** Every credential reads as failed, for a non-details block when the credential state is unavailable. */
function unreadableCredentialState(): AutomationCredentialStateDto {
  const states: Record<string, AutomationCredentialStatus> = {};
  for (const key of AUTOMATION_CREDENTIAL_KEYS) states[key] = "read_failed";
  return {
    revision: 0,
    status: Object.fromEntries(AUTOMATION_CREDENTIAL_KEYS.map((key) => [key, false])),
    states,
    fileNames: {},
    invalidFileKeys: [],
    invalidFileReasons: {},
  };
}

export function externalPrerequisiteById(prerequisiteId: string) {
  for (const task of AUTOMATION_TASKS) {
    const prerequisite = task.externalPrerequisites?.find(
      (candidate) => candidate.id === prerequisiteId,
    );
    if (prerequisite && isValidExternalPrerequisiteMetadata(prerequisite))
      return prerequisite;
  }
  return null;
}

export function automationSetupGuideLink(
  groupId: string,
  linkId: string,
  locale: Locale = "zh-TW",
) {
  const group = AUTOMATION_CREDENTIAL_GROUPS.find(
    (candidate) => candidate.id === groupId,
  );
  const guideLink = group?.setupGuide.links.find(
    (candidate) => candidate.id === linkId,
  );
  if (!guideLink) return null;
  const selectedUrl =
    locale === "en" && guideLink.englishUrl
      ? guideLink.englishUrl
      : guideLink.url;
  try {
    const url = new URL(selectedUrl);
    if (
      url.protocol !== "https:" ||
      !guideLink.allowedHosts.includes(url.hostname)
    )
      return null;
  } catch {
    return null;
  }
  return { ...guideLink, url: selectedUrl };
}

export function automationSaveCredentials(updates: Record<string, string>) {
  for (const key of CERTIFICATE_FILE_CREDENTIAL_KEYS) {
    if (!Object.hasOwn(updates, key)) continue;
    const validation = validateCertificateFilePath(updates[key] ?? "");
    if (!validation.valid) {
      return {
        saved: false as const,
        error: "invalid-certificate-file" as const,
        credentialKey: key,
        reason: validation.reason,
      };
    }
    updates[key] = validation.path;
  }
  const split = splitAutomationUpdates(updates);
  const nextSettings = { ...readAutomationSettings(), ...split.settings };
  for (const group of AUTOMATION_CREDENTIAL_GROUPS) {
    if (!isStatementSelectionGroup(group)) continue;
    const selection = selectStatementTypes(group, nextSettings, "strict");
    if (Object.hasOwn(split.settings, group.statementSelectionKey)) {
      nextSettings[group.statementSelectionKey] =
        selection.selectedIds.join(",");
    }
  }
  const nextCredentials =
    Object.keys(split.credentials).length > 0
      ? {
          ...readAutomationCredentialsFile(),
          ...split.credentials,
        }
      : undefined;
  writeAutomationConfigFiles(nextSettings, nextCredentials);
  return { saved: true as const };
}

export function automationRunHistory(
  provider: AutomationPersistenceProvider,
  limit = 100,
): Promise<AutomationTaskHistoryRow[]> {
  return provider.automation.recentTaskRuns(limit);
}

/**
 * Everything the renderer asks of Automation, in one place: each method is
 * the bridge method of one `automation:*` channel (plus the two Settings
 * actions that drive collection and Sign-in Erasure). The Electron IPC
 * adapter only forwards to it (ADR 0073); Electron capabilities arrive as
 * ports, so this module never imports `electron`.
 */
export function createAutomationDesktopService<Owner>(deps: AutomationDesktopServiceDeps<Owner>) {
  const { runtime, provider, dataVersions } = deps;
  const log = deps.log ?? {
    error: (event, details) => console.error(event, details),
    warn: (event, details) => console.warn(event, details),
  };
  const reportAutomationRuntimeFatal = (stage: string, error?: unknown): never => {
    const details = automationRuntimeFatalDetails(stage, error);
    log.error("automation-runtime-fatal", {
      ...details,
      ...(process.env.NODE_ENV === "development" && error instanceof Error
        ? { stack: error.stack }
        : {}),
    });
    deps.onAutomationRuntimeFatal?.(details);
    throw new Error("Automation runtime snapshot unavailable.");
  };
  const ensureAutomationRuntimeReady = async (stage: string) => {
    try {
      await deps.onAutomationRuntimeReady?.();
    } catch (error) {
      reportAutomationRuntimeFatal(stage, error);
    }
  };
  const credentials = createAutomationCredentialStateCache(
    deps.readCredentialState,
    (event) => log.warn("automation-credential-state-read-failed", event),
  );
  void credentials.prewarm().catch(() => {
    // The details block reports a retryable, user-facing error if this fails.
  });
  const unsubscribeFromRuntime = runtime.subscribe((snapshot) => deps.publishRuntimeChanged(snapshot));
  const runManual = (taskIds: string[]) => {
    const onFinished = deps.onManualCollectionFinished;
    return onFinished ? runAndSummarize(runtime, taskIds, {}, onFinished) : runtime.runMany(taskIds);
  };
  const knownTaskIds = new Set(AUTOMATION_TASKS.map((task) => task.id));

  return Object.freeze({
    loadBlock(block: DashboardBlockKey, options?: DataReadOptions) {
      return withExpectedDataVersion(
        options?.expectedVersion,
        () => dataVersions.snapshot(),
        async () => {
          await ensureAutomationRuntimeReady("automation-block");
          let credentialState: AutomationCredentialStateDto;
          try {
            credentialState = options?.refreshCredentials
              ? await credentials.refresh()
              : await credentials.read();
          } catch (error) {
            if (block === "details") throw new Error("無法讀取登入資料");
            log.warn("automation-credential-state-read-failed", {
              code: "credential-state-unavailable",
              stage: "block",
              block,
              message: error instanceof Error ? error.message : "unknown",
            });
            credentialState = unreadableCredentialState();
          }
          let runtimeSnapshot: AutomationRuntimeSnapshot;
          try {
            runtimeSnapshot = runtime.snapshot();
            assertKnownAutomationRuntimeTasks(runtimeSnapshot, knownTaskIds);
          } catch (error) {
            return reportAutomationRuntimeFatal("automation-block", error);
          }
          const core = await loadAutomationCoreSnapshot(
            provider,
            { snapshot: runtimeSnapshot, activeTaskIds: runtime.activeTaskIds() },
            credentialState.status,
            credentialState.states,
          );
          return projectAutomationBlock(applyAutomationCredentialState(core, credentialState), block);
        },
      );
    },
    async saveCredentials(updates: Record<string, string>) {
      const result = automationSaveCredentials(updates);
      if (result.saved) await credentials.refresh();
      return result;
    },
    deviceRegistrationStatus: (source: unknown) =>
      deps.deviceRegistration.status(registrationSource(source)),
    startDeviceRegistration: (source: unknown) =>
      deps.deviceRegistration.start(registrationSource(source)),
    submitDeviceRegistrationCode(source: unknown, id: unknown, code: unknown) {
      const validSource = registrationSource(source);
      const validId = registrationId(id);
      if (typeof code !== "string" || !ONE_TIME_CODE.test(code)) {
        throw new TypeError("A one-time code must be 4 to 8 digits.");
      }
      return deps.deviceRegistration.submitCode(validSource, validId, code);
    },
    cancelDeviceRegistration(source: unknown, id: unknown): void {
      deps.deviceRegistration.cancel(registrationSource(source), registrationId(id));
    },
    async selectCertificateFile(owner: Owner, locale: Locale) {
      const copy = CERTIFICATE_DIALOG_COPY[locale === "zh-TW" ? "zh-TW" : "en"];
      const result = await deps.chooseFile(owner, {
        title: copy.title,
        properties: ["openFile"],
        filters: [{ name: copy.filter, extensions: [...CERTIFICATE_FILE_EXTENSIONS] }],
      });
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
    async openSetupGuideLink(groupId: string, linkId: string, locale: Locale) {
      const guideLink = automationSetupGuideLink(groupId, linkId, locale);
      if (!guideLink) throw new Error("Unknown or unsafe setup guide link.");
      await deps.openExternal(guideLink.url);
      return { ok: true as const };
    },
    async run(taskId: string) {
      await ensureAutomationRuntimeReady("automation-run");
      const onFinished = deps.onManualCollectionFinished;
      if (!onFinished || !isSourceTask(taskId)) return runtime.run(taskId);
      try {
        return await runtime.run(taskId, { onSettled: (_taskId, run) => onFinished([{ taskId, run }]) });
      } catch (error) {
        onFinished([{ taskId, run: null }]);
        throw error;
      }
    },
    async runMany(taskIds: string[]) {
      await ensureAutomationRuntimeReady("automation-run-many");
      return runManual(taskIds);
    },
    cancel: (taskId: string, expectedRunId?: string) => runtime.cancel(taskId, expectedRunId),
    forceTerminate: (taskId: string, expectedRunId?: string) => runtime.forceTerminate(taskId, expectedRunId),
    runHistory: () => automationRunHistory(provider),
    takeNotificationTarget: () => deps.notificationTarget.take(),
    previewStructureReport(taskId: string) {
      const report = deps.structureReports.get(taskId);
      return report ? renderPreviewStructureReport(report, deps.appVersion()) : null;
    },
    async openPreviewStructureReportIssue(taskId: string) {
      const source = previewSourceForTask(taskId);
      if (!source || !deps.structureReports.get(taskId)) throw new Error("No preview structure report for this task.");
      await deps.openExternal(previewStructureReportIssueUrl(source));
      return { ok: true as const };
    },
    async openExternalPrerequisite(prerequisiteId: string) {
      const prerequisite = externalPrerequisiteById(prerequisiteId);
      if (!prerequisite)
        throw new Error("Unknown or unsafe external prerequisite.");
      await deps.openExternal(prerequisite.downloadUrl);
      return { ok: true as const };
    },
    async runtimeSnapshot() {
      try {
        await ensureAutomationRuntimeReady("runtime-snapshot");
        return runtime.snapshot();
      } catch (error) {
        return reportAutomationRuntimeFatal("runtime-snapshot", error);
      }
    },
    fatalRuntimeSnapshot(): void {
      reportAutomationRuntimeFatal("renderer-resync");
    },
    clearSignInData: () => clearAllSignInData(
      deps.collection,
      {
        cancelRegistrations: () => deps.deviceRegistration.cancelAll(),
        erase: () => deps.eraseSignInDetails({
          credentialsPath: AUTOMATION_CREDENTIALS_PATH,
          userDataDirectory: deps.userDataDirectory(),
          codec: getAutomationCredentialCodec(),
        }),
        refresh: () => credentials.refresh(),
      },
      dataVersions,
    ),
    async collectAllSources() {
      await ensureAutomationRuntimeReady("collect-all-sources");
      const model = await runtime.desktopModel();
      return runManual(scheduledCollectionTaskIds(model.automation));
    },
    /** Stops publishing runtime changes. */
    close() {
      unsubscribeFromRuntime();
    },
  });
}

export type AutomationDesktopService<Owner> = ReturnType<typeof createAutomationDesktopService<Owner>>;
