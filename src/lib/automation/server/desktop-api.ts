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
  hasActiveAutomationTask,
  resumeSessionFromLog,
  startAutomationResume,
  startAutomationTask,
} from "./runner.ts";
import { importGateStatus, latestTaskRuns } from "./store.ts";
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

function missingCredentialKeys(taskId: string) {
  const task = taskById(taskId);
  if (!task) return [];
  const status = currentCredentialStatus();
  return task.credentialKeys.filter((key) => !optionalCredentialKeys.has(key) && !status[key]);
}

export function assertAutomationTaskCanStart(taskId: string, ledgerDir = process.env.LEDGER_DIR ?? "data/ledger") {
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);
  const model = loadAutomationDesktopModel(ledgerDir);
  const row = model.automation.tasks.find((item) => item.id === taskId);
  if (!row) throw new Error("Task is disabled.");
  if (row.status === "locked") {
    throw new Error("Import is locked until all crawler dependencies complete for the business day.");
  }
  const missing = missingCredentialKeys(taskId);
  if (missing.length > 0) throw new Error(`Missing credentials: ${missing.join(", ")}`);
  return task;
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

export function automationRun(taskId: string) {
  const task = assertAutomationTaskCanStart(taskId);
  startAutomationTask(task.id);
  return { started: task.id };
}

export function automationResume(taskId: string) {
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);
  const model = loadAutomationDesktopModel();
  const row = model.automation.tasks.find((item) => item.id === taskId);
  if (!row) throw new Error("Task is disabled.");
  if (row.status !== "waiting_for_human") throw new Error("Task is not waiting for human input.");
  const session = resumeSessionFromLog(row.logTail);
  if (!session) throw new Error("Missing Libretto resume session in latest log.");
  startAutomationResume(task.id, session);
  return { resumed: task.id };
}
