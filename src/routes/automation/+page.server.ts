import { fail } from "@sveltejs/kit";
import type { Actions } from "./$types";
import {
  AUTOMATION_CREDENTIAL_GROUPS,
  AUTOMATION_CREDENTIAL_KEYS,
  enabledAutomationTasks,
  enabledCsvImportDependencyIds,
  taskById,
} from "$lib/automation/server/tasks.ts";
import {
  credentialStatusFromValues,
  readAutomationCredentialsFile,
  splitAutomationUpdates,
  writeAutomationCredentials,
  writeAutomationSettings,
} from "$lib/automation/server/config-files.ts";
import { businessDayUtcRange } from "$lib/automation/server/business-day.ts";
import { buildAutomationPageModel } from "$lib/automation/server/page-model.ts";
import {
  automationBusinessTimezone,
  automationGroupEnabledStatus,
  readAutomationSettings,
} from "$lib/automation/server/settings.ts";
import {
  activeAutomationTaskIds,
  hasActiveAutomationTask,
  resumeSessionFromLog,
  startAutomationResume,
  startAutomationTask,
} from "$lib/automation/server/runner.ts";
import { importGateStatus, latestTaskRuns } from "$lib/automation/server/store.ts";
import { openLedgerDatabase } from "../../ledger/db/client.ts";

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

function currentAutomationModel() {
  const settings = readAutomationSettings();
  const enabledGroups = automationGroupEnabledStatus(settings);
  const db = openLedgerDatabase();
  try {
    const activeTaskIds = activeAutomationTaskIds();
    const range = businessDayUtcRange(undefined, automationBusinessTimezone(settings));
    const importGate = importGateStatus(db, {
      dependencyIds: enabledCsvImportDependencyIds(enabledGroups),
      startUtc: range.startUtc,
      endUtc: range.endUtc,
    });
    return buildAutomationPageModel({
      tasks: enabledAutomationTasks(enabledGroups),
      latestRuns: latestTaskRuns(db),
      activeTaskIds,
      credentials: currentCredentialStatus(),
      importGate,
      active: activeTaskIds.length > 0 || hasActiveAutomationTask(),
      businessDate: range.businessDate,
    });
  } finally {
    db.close();
  }
}

function missingCredentialKeys(taskId: string) {
  const task = taskById(taskId);
  if (!task) return [];
  const status = currentCredentialStatus();
  return task.credentialKeys.filter((key) => (
    !optionalCredentialKeys.has(key) && !status[key]
  ));
}

function formTaskId(formData: FormData) {
  const taskId = String(formData.get("taskId") ?? "");
  if (!taskById(taskId)) throw new Error(`Unknown automation task: ${taskId}`);
  return taskId;
}

function startTask(taskId: string) {
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);

  const model = currentAutomationModel();
  const row = model.tasks.find((item) => item.id === taskId);
  if (!row) {
    return fail(409, { message: "Task is disabled." });
  }
  if (row?.status === "locked") {
    return fail(409, {
      message: "Import is locked until all crawler dependencies complete for the business day.",
    });
  }

  const missing = missingCredentialKeys(taskId);
  if (missing.length > 0) {
    return fail(400, {
      message: `Missing credentials: ${missing.join(", ")}`,
    });
  }

  try {
    startAutomationTask(task.id);
    return { started: task.id };
  } catch (error) {
    return fail(409, {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function resumeTask(taskId: string) {
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);

  const model = currentAutomationModel();
  const row = model.tasks.find((item) => item.id === taskId);
  if (!row) {
    return fail(409, { message: "Task is disabled." });
  }
  if (row?.status !== "waiting_for_human") {
    return fail(409, { message: "Task is not waiting for human input." });
  }

  const session = resumeSessionFromLog(row.logTail);
  if (!session) {
    return fail(409, { message: "Missing Libretto resume session in latest log." });
  }

  try {
    startAutomationResume(task.id, session);
    return { resumed: task.id };
  } catch (error) {
    return fail(409, {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function load() {
  const settings = readAutomationSettings();
  const enabledGroups = automationGroupEnabledStatus(settings);
  return {
    automation: currentAutomationModel(),
    credentialGroups: AUTOMATION_CREDENTIAL_GROUPS.map((group) => ({
      ...group,
      enabled: enabledGroups[group.id] !== false,
    })),
  };
}

export const actions: Actions = {
  saveCredentials: async ({ request }) => {
    const formData = await request.formData();
    const updates: Record<string, string> = {};
    for (const group of AUTOMATION_CREDENTIAL_GROUPS) {
      updates[group.enabledKey] = formData.getAll(group.enabledKey).includes("true") ? "true" : "false";
    }
    for (const key of AUTOMATION_CREDENTIAL_KEYS) {
      const value = String(formData.get(key) ?? "").trim();
      if (value) updates[key] = value;
    }
    const { settings, credentials } = splitAutomationUpdates(updates);
    writeAutomationSettings({
      ...readAutomationSettings(),
      ...settings,
    });
    if (Object.keys(credentials).length > 0) {
      writeAutomationCredentials({
        ...readAutomationCredentialsFile(),
        ...credentials,
      });
    }
    return { saved: true };
  },
  run: async ({ request }) => {
    const formData = await request.formData();
    return startTask(formTaskId(formData));
  },
  resume: async ({ request }) => {
    const formData = await request.formData();
    return resumeTask(formTaskId(formData));
  },
};
