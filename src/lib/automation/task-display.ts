import type { Locale } from "../i18n/i18n.ts";
import { sourceLogo } from "../institutions/institutions.ts";
import { formatUtcDateTime } from "../time/timezone.ts";
import type { AutomationTaskRow, AutomationTaskStatus } from "./types.ts";

/** The chip tone for a run status; shared by the run list and Run history. */
export function statusClass(status: AutomationTaskStatus): "good" | "bad" | "warn" | "" {
  if (status === "completed") return "good";
  if (status === "failed" || status === "locked") return "bad";
  if (status === "running" || status === "waiting_for_human" || status === "partial" || status === "needs_setup" || status === "reset_required") return "warn";
  return "";
}

export function taskLabel(task: Pick<AutomationTaskRow, "displayName">, language: Locale): string {
  return task.displayName[language];
}

export function taskLogo(task: Pick<AutomationTaskRow, "credentialGroupId">) {
  return task.credentialGroupId ? sourceLogo(task.credentialGroupId) : null;
}

export function formatRunTime(value: string | null, timeZone: string, language: Locale): string {
  return formatUtcDateTime(value, timeZone, language) || "--";
}
