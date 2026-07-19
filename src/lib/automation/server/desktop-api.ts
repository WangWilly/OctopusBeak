import {
  AUTOMATION_CREDENTIAL_GROUPS,
  AUTOMATION_CREDENTIAL_KEYS,
  enabledAutomationTasks,
  enabledCsvImportDependencyIds,
  taskById,
} from "./tasks.ts";
import {
  credentialStatusFromValues,
  readAutomationCredentialsFile,
  splitAutomationUpdates,
  writeAutomationCredentials,
  writeAutomationSettings,
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
} from "./runner.ts";
import {
  importGateStatus,
  latestTaskRuns,
  recentTaskRuns,
  todayTaskRunIds,
} from "./store.ts";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import type { AutomationDesktopModel } from "$lib/desktop/api.ts";

const optionalCredentialKeys = new Set(["MAX_SUB_ACCOUNT"]);

function currentCredentialStatus() {
  const settings = readAutomationSettings();
  const credentials = readAutomationCredentialsFile();
  const status = credentialStatusFromValues(credentials, AUTOMATION_CREDENTIAL_KEYS);
  for (const key of AUTOMATION_CREDENTIAL_KEYS) {
    status[key] = status[key] || Boolean(settings[key]) || Boolean(process.env[key]?.trim());
  }
  return status;
}

export function loadAutomationDesktopModel(ledgerDir = process.env.LEDGER_DIR ?? "data/ledger"): AutomationDesktopModel {
  const settings = readAutomationSettings();
  const enabledGroups = automationGroupEnabledStatus(settings);
  const db = openLedgerDatabase(ledgerDir);
  try {
    const activeTaskIds = activeAutomationTaskIds();
    const range = businessDayUtcRange(undefined, automationBusinessTimezone(settings));
    const importGate = importGateStatus(db, {
      dependencyIds: enabledCsvImportDependencyIds(enabledGroups),
      startUtc: range.startUtc,
      endUtc: range.endUtc,
    });
    return {
      automation: buildAutomationPageModel({
        tasks: enabledAutomationTasks(enabledGroups),
        latestRuns: latestTaskRuns(db),
        todayRunTaskIds: todayTaskRunIds(db, {
          startUtc: range.startUtc,
          endUtc: range.endUtc,
        }),
        activeTaskIds,
        credentials: currentCredentialStatus(),
        importGate,
        active: activeTaskIds.length > 0 || hasActiveAutomationTask(),
        businessDate: range.businessDate,
      }),
      credentialGroups: AUTOMATION_CREDENTIAL_GROUPS.map((group) => ({
        ...group,
        enabled: enabledGroups[group.id] !== false,
      })),
    };
  } finally {
    db.close();
  }
}

function missingCredentialKeys(taskId: string, status = currentCredentialStatus()) {
  const task = taskById(taskId);
  if (!task) return [];
  return task.credentialKeys.filter((key) => !optionalCredentialKeys.has(key) && !status[key]);
}

function assertAutomationTaskCanStartInModel(taskId: string, model: AutomationDesktopModel) {
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);
  const row = model.automation.tasks.find((item) => item.id === taskId);
  if (!row) throw new Error("Task is disabled.");
  if (row.status === "waiting_for_human") {
    throw new Error("Task is waiting for human input. Resume or force quit it first.");
  }
  if (row.status === "locked") {
    throw new Error("Import is locked until all crawler dependencies complete for the business day.");
  }
  const missing = missingCredentialKeys(taskId, model.automation.credentials);
  if (missing.length > 0) throw new Error(`Missing credentials: ${missing.join(", ")}`);
  return task;
}

export function assertAutomationTasksCanStart(taskIds: readonly string[], model: AutomationDesktopModel) {
  return [...new Set(taskIds)].map((taskId) => assertAutomationTaskCanStartInModel(taskId, model));
}

export function assertAutomationTaskCanStart(taskId: string, ledgerDir = process.env.LEDGER_DIR ?? "data/ledger") {
  return assertAutomationTaskCanStartInModel(taskId, loadAutomationDesktopModel(ledgerDir));
}

export function automationSaveCredentials(updates: Record<string, string>) {
  const split = splitAutomationUpdates(updates);
  writeAutomationSettings({
    ...readAutomationSettings(),
    ...split.settings,
  });
  if (Object.keys(split.credentials).length > 0) {
    writeAutomationCredentials({
      ...readAutomationCredentialsFile(),
      ...split.credentials,
    });
  }
  return { saved: true as const };
}

export function automationRun(taskId: string, ledgerDir = process.env.LEDGER_DIR ?? "data/ledger") {
  const task = assertAutomationTaskCanStart(taskId, ledgerDir);
  startAutomationTask(task.id, ledgerDir);
  return { started: task.id };
}

export function automationRunMany(taskIds: string[], ledgerDir = process.env.LEDGER_DIR ?? "data/ledger") {
  if (!Array.isArray(taskIds) || taskIds.some((taskId) => typeof taskId !== "string")) {
    throw new TypeError("Task IDs must be an array of strings.");
  }
  if (taskIds.length === 0) return { started: [] as string[] };
  const tasks = assertAutomationTasksCanStart(taskIds, loadAutomationDesktopModel(ledgerDir));
  for (const task of tasks) startAutomationTask(task.id, ledgerDir);
  return { started: tasks.map((task) => task.id) };
}

export function automationCancel(taskId: string) {
  return cancelAutomationTask(taskId);
}

export function automationRunHistory(ledgerDir = process.env.LEDGER_DIR ?? "data/ledger") {
  const db = openLedgerDatabase(ledgerDir);
  try {
    return recentTaskRuns(db, 100);
  } finally {
    db.close();
  }
}

export function automationResume(taskId: string, ledgerDir = process.env.LEDGER_DIR ?? "data/ledger") {
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);
  const model = loadAutomationDesktopModel(ledgerDir);
  const row = model.automation.tasks.find((item) => item.id === taskId);
  if (!row) throw new Error("Task is disabled.");
  if (row.status !== "waiting_for_human") throw new Error("Task is not waiting for human input.");
  const session = resumeSessionFromLog(row.logTail);
  if (!session) throw new Error("Missing Libretto resume session in latest log.");
  startAutomationResume(task.id, session, ledgerDir);
  return { resumed: task.id };
}
