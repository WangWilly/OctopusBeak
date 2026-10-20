import {
  AUTOMATION_CREDENTIAL_GROUPS,
  AUTOMATION_CREDENTIAL_KEYS,
  AUTOMATION_TASKS,
  enabledAutomationTasks,
  taskById,
} from "./tasks.ts";
import {
  isStatementSelectionGroup,
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
  offeredAutomationSources,
  readAutomationSettings,
} from "./settings.ts";
import { automationRunner, type StartAutomationTaskOptions } from "./runner.ts";
import {
  type AutomationPersistenceProvider,
  type AutomationTaskHistoryRow,
  type AutomationTaskPrerequisiteNoticeRecord,
} from "./store.ts";
import { isValidExternalPrerequisiteMetadata } from "../external-prerequisite.ts";
import {
  certificateFilename,
  validateCertificateFilePath,
} from "./credential-file.ts";
import type {
  AutomationCoreSnapshot,
  AutomationCredentialGroupCoreDto,
  AutomationCredentialStateDto,
  AutomationDesktopModel,
  AutomationRunManyResult,
  AutomationRunManyTaskResult,
  AutomationRuntimeSnapshot,
} from "$lib/desktop/api.ts";
import { automationRuntimeState } from "./runtime-state.ts";

const optionalCredentialKeys = new Set(["MAX_SUB_ACCOUNT"]);
const certificateFileCredentialKeys = new Set([
  "LIBRETTO_CLOUD_YUANTA_TRADE_CA_PATH",
]);

function pagePrerequisiteNoticesFromRows(
  notices: readonly AutomationTaskPrerequisiteNoticeRecord[],
) {
  return notices.flatMap((notice) => {
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

function credentialStatesFromStatus(status: Readonly<Record<string, boolean>>) {
  return Object.fromEntries(
    Object.entries(status).map(([key, value]) => [key, value ? "ready" : "missing"]),
  ) as Record<string, "ready" | "missing">;
}

/** Main-process-only credential reader; never call this from a worker. */
export function readAutomationCredentialState() {
  const state = currentCredentialState();
  return {
    status: state.status,
    fileNames: state.fileNames,
    invalidFileKeys: state.invalidFileKeys,
    invalidFileReasons: state.invalidFileReasons,
  };
}

function coreCredentialGroup(
  group: (typeof AUTOMATION_CREDENTIAL_GROUPS)[number],
  enabled: boolean,
  selectedStatementTypeIds: readonly string[],
  statementSetupRequired: boolean,
): AutomationCredentialGroupCoreDto & {
  storedCredentialFileNames: Readonly<Record<string, string>>;
  invalidCredentialFileKeys: readonly string[];
  invalidCredentialFileReasons: Readonly<Record<string, "invalid-extension" | "missing-or-unreadable">>;
} {
  return {
    ...group,
    enabled,
    selectedStatementTypeIds,
    statementSetupRequired,
    storedCredentialFileNames: {},
    invalidCredentialFileKeys: [],
    invalidCredentialFileReasons: {},
  };
}

/**
 * Build the automation data that does not require access to encrypted
 * credentials.  Workers use this function directly; the credential state is
 * supplied separately by Electron main only for the details block.
 */
/**
 * Promise-based page snapshot seam for the worker-owned PGlite store.  All
 * persistence reads are awaited before the page model is assembled, keeping
 * runtime state and persisted history from being published out of order.
 */
export async function loadAutomationCoreSnapshot(
  provider: AutomationPersistenceProvider,
  credentialStatus: Readonly<Record<string, boolean>> = {},
  runtime: AutomationRuntimeSnapshot = automationRuntimeState.snapshot(),
  credentialStates: Readonly<Record<string, "loading" | "ready" | "missing" | "read_failed">> = credentialStatesFromStatus(credentialStatus),
): Promise<AutomationCoreSnapshot> {
  const settings = readAutomationSettings();
  const { credentialGroups: offeredGroups, enabledGroups } = offeredAutomationSources(settings);
  const activeTaskIds = automationRunner.activeTaskIds();
  const range = businessDayUtcRange(undefined, automationBusinessTimezone(settings));
  const [latestRuns, todayRunTaskIds, notices] = await Promise.all([
    provider.automation.latestTaskRuns(),
    provider.automation.todayTaskRunIds({ startUtc: range.startUtc, endUtc: range.endUtc }),
    provider.automation.activeTaskPrerequisiteNotices(),
  ]);
  const credentialGroups = offeredGroups.map((group) => {
    const enabled = enabledGroups[group.id] !== false;
    const selectionSettings = { ...settings, [group.enabledKey]: enabled };
    const selection = isStatementSelectionGroup(group)
      ? selectStatementTypes(group, selectionSettings, "display")
      : { selectedIds: [], needsSetup: false };
    return coreCredentialGroup(
      group,
      enabled,
      selection.selectedIds,
      selection.needsSetup,
    );
  });
  return {
    runtimeSessionId: runtime.sessionId,
    runtimeRevision: runtime.revision,
    automation: {
      ...buildAutomationPageModel({
        tasks: enabledAutomationTasks(enabledGroups),
        latestRuns,
        todayRunTaskIds,
        activeTaskIds,
        credentials: { ...credentialStatus },
        setupRequiredGroupIds: new Set(
          credentialGroups
            .filter((group) => group.statementSetupRequired)
            .map((group) => group.id),
        ),
        externalPrerequisiteNotices: pagePrerequisiteNoticesFromRows(notices),
        active: activeTaskIds.length > 0,
        businessDate: range.businessDate,
        runtime,
        credentialStates: { ...credentialStates },
      }),
    },
    credentialGroups,
  };
}

/** Apply the sanitized main-process state without reading credentials. */
export function applyAutomationCredentialState(
  core: AutomationCoreSnapshot,
  credentialState: AutomationCredentialStateDto,
): AutomationDesktopModel {
  const credentialGroups = core.credentialGroups.map((group) => ({
    ...group,
    storedCredentialFileNames: credentialState.fileNames,
    invalidCredentialFileKeys: credentialState.invalidFileKeys,
    invalidCredentialFileReasons: credentialState.invalidFileReasons,
  }));
  return {
    runtimeSessionId: core.runtimeSessionId,
    runtimeRevision: core.runtimeRevision,
    automation: {
      ...core.automation,
      credentials: { ...credentialState.status },
      credentialStates: credentialState.states
        ? { ...credentialState.states }
        : credentialStatesFromStatus(credentialState.status),
    },
    credentialGroups,
  };
}

export async function loadAutomationDesktopModel(
  provider: AutomationPersistenceProvider,
): Promise<AutomationDesktopModel> {
  const raw = currentCredentialState();
  const credentialState: AutomationCredentialStateDto = {
    revision: 0,
    status: raw.status,
    fileNames: raw.fileNames,
    invalidFileKeys: raw.invalidFileKeys,
    invalidFileReasons: raw.invalidFileReasons,
  };
  return applyAutomationCredentialState(
    await loadAutomationCoreSnapshot(provider, raw.status),
    credentialState,
  );
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
      "Task is waiting for verification. Wait for it to finish or cancel the run first.",
    );
  }
  const group = task.credentialGroupId
    ? AUTOMATION_CREDENTIAL_GROUPS.find(
        (candidate) => candidate.id === task.credentialGroupId,
      )
    : null;
  if (group && isStatementSelectionGroup(group)) {
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

export async function assertAutomationTaskCanStart(
  taskId: string,
  provider: AutomationPersistenceProvider,
) {
  return assertAutomationTaskCanStartInModel(
    taskId,
    await loadAutomationDesktopModel(provider),
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

export async function automationRun(
  taskId: string,
  provider: AutomationPersistenceProvider,
): Promise<{ started: string; runId: string; runtime: ReturnType<typeof automationRuntimeState.snapshot> }> {
  const current = await automationRunner.current(taskId);
  if (current) {
    return { started: taskId, runId: current.runId, runtime: current.runtime };
  }
  const model = await loadAutomationDesktopModel(provider);
  const task = assertAutomationTaskCanStartInModel(taskId, model);
  const started = await automationRunner.start(task.id, provider);
  return { started: task.id, runId: started.runId, runtime: started.runtime };
}

export async function automationRunMany(
  taskIds: string[],
  provider: AutomationPersistenceProvider,
  options: StartAutomationTaskOptions = {},
): Promise<AutomationRunManyResult> {
  if (!Array.isArray(taskIds) || taskIds.some((taskId) => typeof taskId !== "string")) {
    throw new TypeError("Task IDs must be an array of strings.");
  }
  if (taskIds.length === 0) return { started: [] as string[], results: {} };
  const model = await loadAutomationDesktopModel(provider);
  const started: string[] = [];
  const errors: Record<string, string> = {};
  const results: Record<string, AutomationRunManyTaskResult> = {};
  for (const taskId of [...new Set(taskIds)]) {
    try {
      const existing = await automationRunner.current(taskId);
      if (existing) {
        results[taskId] = { status: "already_running", runId: existing.runId };
        continue;
      }
      const task = assertAutomationTaskCanStartInModel(taskId, model);
      const run = await automationRunner.start(task.id, provider, options);
      started.push(task.id);
      results[task.id] = { status: "started", runId: run.runId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors[taskId] = message;
      results[taskId] = { status: "error", error: message };
    }
  }
  return { started, results, ...(Object.keys(errors).length ? { errors } : {}) };
}

export function automationCancel(
  taskId: string,
  expectedRunId?: string,
): Promise<{ cancelled: string }> {
  return automationRunner.cancel(taskId, expectedRunId);
}

export function automationForceTerminate(
  taskId: string,
  expectedRunId?: string,
): Promise<{ cancelled: string }> {
  return automationRunner.forceTerminate(taskId, expectedRunId);
}

export function automationRunHistory(
  provider: AutomationPersistenceProvider,
  limit = 100,
): Promise<AutomationTaskHistoryRow[]> {
  return provider.automation.recentTaskRuns(limit);
}
