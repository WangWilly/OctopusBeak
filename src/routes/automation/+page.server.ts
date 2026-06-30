import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fail } from "@sveltejs/kit";
import type { Actions } from "./$types";
import { AUTOMATION_CREDENTIAL_KEYS, AUTOMATION_TASKS, taskById } from "$lib/automation/server/tasks.ts";
import { credentialStatus, updateEnvText } from "$lib/automation/server/env-file.ts";
import { businessDayUtcRange } from "$lib/automation/server/business-day.ts";
import { buildAutomationPageModel } from "$lib/automation/server/page-model.ts";
import {
  hasActiveAutomationTask,
  resumeSessionFromLog,
  startAutomationResume,
  startAutomationTask,
} from "$lib/automation/server/runner.ts";
import { importGateStatus, latestTaskRuns } from "$lib/automation/server/store.ts";
import { openLedgerDatabase } from "../../ledger/db/client.ts";

const envPath = resolve(".env");
const optionalCredentialKeys = new Set(["MAX_SUB_ACCOUNT"]);

function readEnvText() {
  return existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
}

function currentCredentialStatus(envText: string) {
  const status = credentialStatus(envText, AUTOMATION_CREDENTIAL_KEYS);
  for (const key of AUTOMATION_CREDENTIAL_KEYS) {
    status[key] = status[key] || Boolean(process.env[key]?.trim());
  }
  return status;
}

function currentAutomationModel() {
  const envText = readEnvText();
  const db = openLedgerDatabase();
  try {
    const range = businessDayUtcRange();
    const importGate = importGateStatus(db, {
      dependencyIds: taskById("import-downloads-csv")?.dependencies ?? [],
      startUtc: range.startUtc,
      endUtc: range.endUtc,
    });
    return buildAutomationPageModel({
      tasks: AUTOMATION_TASKS,
      latestRuns: latestTaskRuns(db),
      credentials: currentCredentialStatus(envText),
      importGate,
      active: hasActiveAutomationTask(),
      businessDate: range.businessDate,
    });
  } finally {
    db.close();
  }
}

function missingCredentialKeys(taskId: string) {
  const task = taskById(taskId);
  if (!task) return [];
  const status = currentCredentialStatus(readEnvText());
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
  return {
    automation: currentAutomationModel(),
    credentialKeys: AUTOMATION_CREDENTIAL_KEYS,
  };
}

export const actions: Actions = {
  saveCredentials: async ({ request }) => {
    const formData = await request.formData();
    const updates: Record<string, string> = {};
    for (const key of AUTOMATION_CREDENTIAL_KEYS) {
      const value = String(formData.get(key) ?? "").trim();
      if (value) updates[key] = value;
    }
    if (Object.keys(updates).length === 0) {
      return { saved: false };
    }
    writeFileSync(envPath, updateEnvText(readEnvText(), updates), "utf8");
    return { saved: true };
  },
  run: async ({ request }) => {
    const formData = await request.formData();
    return startTask(formTaskId(formData));
  },
  retry: async ({ request }) => {
    const formData = await request.formData();
    return startTask(formTaskId(formData));
  },
  resume: async ({ request }) => {
    const formData = await request.formData();
    return resumeTask(formTaskId(formData));
  },
};
