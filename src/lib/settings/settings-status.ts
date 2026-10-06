import type { AutomationTaskRow } from "../automation/types.ts";
import type { CredentialGroupDto } from "../desktop/api.ts";
import { dateInTimeZone } from "../shared-ledger/twd-valuation.ts";
import { zonedDateTimeToUtc } from "../time/timezone.ts";

const EXCHANGE_RATE_TASK_ID = "exchange-rates";
const DAY_MS = 86_400_000;

export type ExchangeRateRun = { finishedAt: string; succeeded: boolean };

/** Sources that are switched on and have every sign-in field stored. */
export function linkedSourceCount(
  groups: readonly Pick<CredentialGroupDto, "enabled" | "credentialKeys">[],
  credentials: Readonly<Record<string, boolean>>,
): number {
  return groups.filter((group) => group.enabled && group.credentialKeys.every((key) => credentials[key])).length;
}

export function latestExchangeRateRun(
  tasks: readonly Pick<AutomationTaskRow, "id" | "status" | "latestFinishedAt">[],
): ExchangeRateRun | null {
  const task = tasks.find((candidate) => candidate.id === EXCHANGE_RATE_TASK_ID);
  if (!task?.latestFinishedAt) return null;
  return { finishedAt: task.latestFinishedAt, succeeded: task.status === "completed" };
}

/** The next instant the daily `HH:MM` slot occurs in `timeZone`, strictly after `now`. */
export function nextDailyRun(time: string, timeZone: string, now: Date): string {
  const today = dateInTimeZone(now, timeZone);
  for (let days = 0; days < 3; days += 1) {
    const date = new Date(Date.parse(`${today}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
    try {
      const run = zonedDateTimeToUtc(date, `${time}:00`, timeZone);
      if (Date.parse(run) > now.getTime()) return run;
    } catch {
      // The slot falls in a daylight-saving gap that day; try the next one.
    }
  }
  throw new RangeError(`No daily run found for ${time} in ${timeZone}`);
}

export function utcOffsetLabel(timeZone: string, now: Date): string {
  const offset = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(now)
    .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  return offset === "GMT" ? "UTC+00:00" : offset.replace("GMT", "UTC");
}
