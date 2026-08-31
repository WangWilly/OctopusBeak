import {
  AUTOMATION_CREDENTIAL_GROUPS,
  AUTOMATION_CREDENTIAL_KEYS,
  AUTOMATION_TASKS,
  enabledAutomationTasks,
  enabledCsvImportDependencyIds,
  taskById,
} from "./tasks.ts";
import {
  isStatementSelectionGroup,
  allSupportedStatementTypeIds,
  selectStatementTypes,
} from "../statement-selection.ts";
import {
  credentialStatusFromValues,
  readAutomationCredentialsFile,
  splitAutomationUpdates,
  writeAutomationConfigFiles,
} from "./config-files.ts";
import { businessDayUtcRange } from "./business-day.ts";
import { buildAutomationPageModel } from "./page-model.ts";
import {
  automationBusinessTimezone,
  automationGroupEnabledStatus,
  readAutomationSettings,
} from "./settings.ts";
import {
  activeAutomationTaskIds,
  cancelAutomationTask,
  hasActiveAutomationTask,
  resumeSessionFromLog,
  startAutomationResume,
  startAutomationTask,
  startAutomationTasks,
} from "./runner.ts";
import {
  importGateStatus,
  activeTaskPrerequisiteNotices,
  latestTaskRuns,
  recentTaskRuns,
  todayTaskRunIds,
} from "./store.ts";
import { isValidExternalPrerequisiteMetadata } from "../external-prerequisite.ts";
import {
  certificateFilename,
  validateCertificateFilePath,
} from "./credential-file.ts";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import type { AutomationDesktopModel } from "$lib/desktop/api.ts";
import type {
  CathayGmailOtpConnectionError,
  CathayGmailOtpStatus,
} from "../types.ts";
import type { HumanAssistanceCompletion } from "../human-assistance.ts";
import {
  cathayGmailOtpStatus as readCathayGmailOtpStatus,
  disconnectCathayGmailOtp as disconnectCathayGmailOtpCore,
  enableCathayGmailOtp as enableCathayGmailOtpCore,
  setCathayGmailOtpEnabled as setCathayGmailOtpEnabledCore,
} from "./gmail-otp-service.ts";

const cathayGmailOtpConnectionErrors = new Set<CathayGmailOtpConnectionError>([
  "authorization-cancelled",
  "authorization-failed",
  "token-exchange-failed",
  "gmail-profile-failed",
  "credential-storage-failed",
]);

function sanitizedCathayGmailOtpStatus(
  status = readCathayGmailOtpStatus(),
): CathayGmailOtpStatus {
  const connectedEmail =
    typeof status.connectedEmail === "string" && status.connectedEmail.trim()
      ? status.connectedEmail.trim()
      : null;
  const connectionError =
    typeof status.connectionError === "string" &&
    cathayGmailOtpConnectionErrors.has(status.connectionError as CathayGmailOtpConnectionError)
      ? status.connectionError as CathayGmailOtpConnectionError
      : null;
  return {
    enabled: status.enabled === true,
    connectedEmail,
    needsAuthorization: status.needsAuthorization === true,
    ...(connectionError ? { connectionError } : {}),
  };
}

/** Renderer-safe Gmail state; token material never crosses this boundary. */
export function cathayGmailOtpStatus(): CathayGmailOtpStatus {
  return sanitizedCathayGmailOtpStatus();
}

/** Starts the user-initiated OAuth flow and returns sanitized state only. */
export async function enableCathayGmailOtp(): Promise<CathayGmailOtpStatus> {
  return sanitizedCathayGmailOtpStatus(await enableCathayGmailOtpCore());
}

/** Disabling keeps the Google grant; the core owns that lifecycle rule. */
export async function setCathayGmailOtpEnabled(
  enabled: boolean,
): Promise<CathayGmailOtpStatus> {
  if (typeof enabled !== "boolean") {
    throw new TypeError("Cathay Gmail OTP enabled flag must be boolean.");
  }
  return sanitizedCathayGmailOtpStatus(await setCathayGmailOtpEnabledCore(enabled));
}

/** Revokes/clears the grant through the core and always returns safe state. */
export async function disconnectCathayGmailOtp(): Promise<CathayGmailOtpStatus> {
  await disconnectCathayGmailOtpCore();
  return sanitizedCathayGmailOtpStatus();
}

const optionalCredentialKeys = new Set(["MAX_SUB_ACCOUNT"]);
const certificateFileCredentialKeys = new Set([
  "LIBRETTO_CLOUD_YUANTA_TRADE_CA_PATH",
]);

function pagePrerequisiteNotices(db: ReturnType<typeof openLedgerDatabase>) {
  return activeTaskPrerequisiteNotices(db).flatMap((notice) => {
    const prerequisite = taskById(notice.taskId)?.externalPrerequisites?.find(
      (candidate) => candidate.id === notice.prerequisiteId,
    );
    if (!prerequisite || !isValidExternalPrerequisiteMetadata(prerequisite))
      return [];
    return [{ ...notice, prerequisite }];
  });
}

function currentCredentialState() {
  const settings = readAutomationSettings();
  const credentials = readAutomationCredentialsFile();
  const status = credentialStatusFromValues(
    credentials,
    AUTOMATION_CREDENTIAL_KEYS,
  );
  const fileNames: Record<string, string> = {};
  const invalidFileKeys: string[] = [];
  const invalidFileReasons: Record<
    string,
    "invalid-extension" | "missing-or-unreadable"
  > = {};
  for (const key of AUTOMATION_CREDENTIAL_KEYS) {
    const settingValue =
      typeof settings[key] === "string" ? settings[key].trim() : "";
    const storedValue =
      credentials[key]?.trim() ||
      settingValue ||
      process.env[key]?.trim() ||
      "";
    if (certificateFileCredentialKeys.has(key)) {
      if (storedValue) fileNames[key] = certificateFilename(storedValue);
      const validation = storedValue
        ? validateCertificateFilePath(storedValue)
        : null;
      status[key] = validation?.valid === true;
      if (storedValue && validation?.valid === false) {
        invalidFileKeys.push(key);
        invalidFileReasons[key] = validation.reason;
      }
      continue;
    }
    status[key] = Boolean(storedValue);
  }
  for (const key of optionalCredentialKeys) status[key] = true;
  return { status, fileNames, invalidFileKeys, invalidFileReasons };
}

export function loadAutomationDesktopModel(
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
): AutomationDesktopModel {
  const settings = readAutomationSettings();
  const enabledGroups = automationGroupEnabledStatus(settings);
  const credentialState = currentCredentialState();
  const db = openLedgerDatabase(ledgerDir);
  try {
    const activeTaskIds = activeAutomationTaskIds();
    const range = businessDayUtcRange(
      undefined,
      automationBusinessTimezone(settings),
    );
    const importGate = importGateStatus(db, {
      dependencyIds: enabledCsvImportDependencyIds(enabledGroups),
      startUtc: range.startUtc,
      endUtc: range.endUtc,
    });
    const credentialGroups = AUTOMATION_CREDENTIAL_GROUPS.map((group) => {
      const enabled = enabledGroups[group.id] !== false;
      const selectionSettings = { ...settings, [group.enabledKey]: enabled };
      const selection = isStatementSelectionGroup(group)
        ? group.id === "fubon" ||
          group.id === "yuanta" ||
          group.id === "sinopac"
          ? {
              selectedIds: allSupportedStatementTypeIds(group),
              needsSetup: false,
            }
          : selectStatementTypes(group, selectionSettings, "display")
        : { selectedIds: [], needsSetup: false };
      return {
        ...group,
        enabled,
        selectedStatementTypeIds: selection.selectedIds,
        statementSetupRequired: selection.needsSetup,
        storedCredentialFileNames: credentialState.fileNames,
        invalidCredentialFileKeys: credentialState.invalidFileKeys,
        invalidCredentialFileReasons: credentialState.invalidFileReasons,
      };
    });
    return {
      automation: {
        ...buildAutomationPageModel({
          tasks: enabledAutomationTasks(enabledGroups),
          latestRuns: latestTaskRuns(db),
          todayRunTaskIds: todayTaskRunIds(db, {
            startUtc: range.startUtc,
            endUtc: range.endUtc,
          }),
          activeTaskIds,
          credentials: credentialState.status,
          importGate,
          setupRequiredGroupIds: new Set(
            credentialGroups
              .filter((group) => group.statementSetupRequired)
              .map((group) => group.id),
          ),
          externalPrerequisiteNotices: pagePrerequisiteNotices(db),
          active: activeTaskIds.length > 0 || hasActiveAutomationTask(),
          businessDate: range.businessDate,
        }),
        cathayGmailOtp: sanitizedCathayGmailOtpStatus(),
      },
      credentialGroups,
    };
  } finally {
    db.close();
  }
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
  locale: "en" | "zh-TW" = "zh-TW",
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

function missingCredentialKeys(
  taskId: string,
  status = currentCredentialState().status,
) {
  const task = taskById(taskId);
  if (!task) return [];
  return task.credentialKeys.filter(
    (key) => !optionalCredentialKeys.has(key) && !status[key],
  );
}

function assertAutomationTaskCanStartInModel(
  taskId: string,
  model: AutomationDesktopModel,
) {
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);
  const row = model.automation.tasks.find((item) => item.id === taskId);
  if (!row) throw new Error("Task is disabled.");
  if (row.status === "waiting_for_human") {
    throw new Error(
      "Task is waiting for human input. Resume or force quit it first.",
    );
  }
  if (row.status === "locked") {
    throw new Error(
      "Import is locked until all crawler dependencies complete for the business day.",
    );
  }
  const group = task.credentialGroupId
    ? AUTOMATION_CREDENTIAL_GROUPS.find(
        (candidate) => candidate.id === task.credentialGroupId,
      )
    : null;
  if (
    group &&
    isStatementSelectionGroup(group) &&
    group.id !== "fubon" &&
    group.id !== "yuanta" &&
    group.id !== "sinopac"
  ) {
    const modelGroup = model.credentialGroups.find(
      (candidate) => candidate.id === group.id,
    );
    const selectionSettings = {
      ...readAutomationSettings(),
      ...(modelGroup ? { [group.enabledKey]: modelGroup.enabled } : {}),
    };
    selectStatementTypes(group, selectionSettings, "strict");
  }
  const missing = missingCredentialKeys(taskId, model.automation.credentials);
  if (missing.length > 0)
    throw new Error(`Missing credentials: ${missing.join(", ")}`);
  return task;
}

export function assertAutomationTasksCanStart(
  taskIds: readonly string[],
  model: AutomationDesktopModel,
) {
  return [...new Set(taskIds)].map((taskId) =>
    assertAutomationTaskCanStartInModel(taskId, model),
  );
}

export function assertAutomationTaskCanStart(
  taskId: string,
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
) {
  return assertAutomationTaskCanStartInModel(
    taskId,
    loadAutomationDesktopModel(ledgerDir),
  );
}

export function automationSaveCredentials(updates: Record<string, string>) {
  for (const key of certificateFileCredentialKeys) {
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
    if (
      group.id === "fubon" ||
      group.id === "yuanta" ||
      group.id === "sinopac"
    ) {
      if (Object.hasOwn(split.settings, group.statementSelectionKey)) {
        nextSettings[group.statementSelectionKey] =
          allSupportedStatementTypeIds(group).join(",");
      }
      continue;
    }
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

export function automationRun(
  taskId: string,
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
) {
  const task = assertAutomationTaskCanStart(taskId, ledgerDir);
  startAutomationTask(task.id, ledgerDir);
  return { started: task.id };
}

export function automationRunMany(
  taskIds: string[],
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
) {
  if (
    !Array.isArray(taskIds) ||
    taskIds.some((taskId) => typeof taskId !== "string")
  ) {
    throw new TypeError("Task IDs must be an array of strings.");
  }
  if (taskIds.length === 0) return { started: [] as string[] };
  const tasks = assertAutomationTasksCanStart(
    taskIds,
    loadAutomationDesktopModel(ledgerDir),
  );
  startAutomationTasks(
    tasks.map((task) => task.id),
    ledgerDir,
  );
  return { started: tasks.map((task) => task.id) };
}

export function automationCancel(taskId: string) {
  return cancelAutomationTask(taskId);
}

export function automationRunHistory(
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
) {
  const db = openLedgerDatabase(ledgerDir);
  try {
    return recentTaskRuns(db, 100);
  } finally {
    db.close();
  }
}

export function assertHumanAssistanceCompletionCanResume(
  completion: HumanAssistanceCompletion | null | undefined,
) {
  if (!completion) {
    throw new Error(
      "Human assistance contract is missing; force quit this legacy run.",
    );
  }
  if (completion.mode === "inline" && completion.status !== "entered") {
    throw new Error(
      "Human verification input is incomplete. Enter the verification input before Resume.",
    );
  }
  if (completion.mode === "independent" && completion.status !== "verified") {
    throw new Error(
      "Human verification is incomplete. Run Check verification before Resume.",
    );
  }
}

export function automationResume(
  taskId: string,
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
) {
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);
  const model = loadAutomationDesktopModel(ledgerDir);
  const row = model.automation.tasks.find((item) => item.id === taskId);
  if (!row) throw new Error("Task is disabled.");
  if (row.status !== "waiting_for_human")
    throw new Error("Task is not waiting for human input.");
  assertHumanAssistanceCompletionCanResume(
    row.humanAssistanceContract?.completion,
  );
  const session = resumeSessionFromLog(row.logTail);
  if (!session)
    throw new Error("Missing Libretto resume session in latest log.");
  startAutomationResume(task.id, session, ledgerDir);
  return { resumed: task.id };
}
