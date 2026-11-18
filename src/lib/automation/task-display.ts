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

const CJK = /[\u3400-\u9fff]/;

/**
 * A name with its other-language name in parentheses, "台北富邦銀行（Taipei Fubon
 * Bank）", split so that name can sit on its own line. A same-language aside,
 * such as （預覽） or (preview), stays part of the name.
 */
export function taskLabelParts(label: string): { name: string; aside: string | null } {
  const match = /^(.+?)\s*[（(]([^（）()]+)[）)]$/.exec(label);
  if (!match || CJK.test(match[1]!) === CJK.test(match[2]!)) return { name: label, aside: null };
  return { name: match[1]!, aside: match[2]! };
}

export function taskLogo(task: Pick<AutomationTaskRow, "credentialGroupId">) {
  return task.credentialGroupId ? sourceLogo(task.credentialGroupId) : null;
}

export function formatRunTime(value: string | null, timeZone: string, language: Locale): string {
  return formatUtcDateTime(value, timeZone, language) || "--";
}
