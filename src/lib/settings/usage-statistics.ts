import type { AutomationSettingsFile } from "../automation/server/config-files.ts";
import { automationFlagEnabled } from "../automation/statement-selection.ts";

/** ADR 0077: the only request the app makes to a host we operate. */
export const USAGE_PING_URL = "https://octopusbeak-telemetry.REPLACE-WITH-SUBDOMAIN.workers.dev/v1/ping";

export const USAGE_STATISTICS_ENABLED_KEY = "USAGE_STATISTICS_ENABLED";
export const USAGE_COHORT_WEEK_KEY = "USAGE_COHORT_WEEK";
export const USAGE_LAST_SENT_DAY_KEY = "USAGE_LAST_SENT_DAY";

/** The first release was published on 2026-07-01; no install is older. */
const FIRST_COHORT_WEEK = "2026-W27";
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;
/** Taiwan has no daylight saving time; the receiver cuts days the same way. */
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Exactly the fields ADR 0077 allows, in the order they are sent. */
export const USAGE_PING_FIELDS = [
  "schema",
  "appVersion",
  "osVersion",
  "arch",
  "locale",
  "cohortWeek",
  "firstThisWeek",
  "firstThisMonth",
] as const;

export type UsagePing = {
  schema: 1;
  appVersion: string;
  osVersion: string;
  arch: "arm64";
  locale: "zh-TW" | "en";
  cohortWeek: string;
  firstThisWeek: boolean;
  firstThisMonth: boolean;
};

export function taipeiDay(instant: Date): string {
  return new Date(instant.getTime() + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
}

/** The ISO 8601 week of a calendar date, as YYYY-Www. */
export function isoWeek(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const weekday = date.getUTCDay() || 7;
  // The Thursday of a week decides which year the week belongs to.
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const year = date.getUTCFullYear();
  const week = Math.ceil(((date.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The week the install first launched, kept inside the range the receiver accepts. */
export function usageCohortWeek(firstLaunch: Date, now: Date): string {
  const week = isoWeek(taipeiDay(firstLaunch));
  const current = isoWeek(taipeiDay(now));
  if (week < FIRST_COHORT_WEEK) return FIRST_COHORT_WEEK;
  return week > current ? current : week;
}

/** macOS major.minor only; patch versions are dropped. */
export function usageOsVersion(systemVersion: string): string {
  const [major = "0", minor = "0"] = systemVersion.split(".");
  return `${major}.${minor}`;
}

export function buildUsagePing(input: {
  now: Date;
  appVersion: string;
  systemVersion: string;
  locale: "zh-TW" | "en";
  cohortWeek: string;
  lastSentDay: string | null;
}): UsagePing {
  const today = taipeiDay(input.now);
  const last = input.lastSentDay;
  return {
    schema: 1,
    appVersion: input.appVersion,
    osVersion: usageOsVersion(input.systemVersion),
    arch: "arm64",
    locale: input.locale,
    cohortWeek: input.cohortWeek,
    firstThisWeek: last === null || isoWeek(last) !== isoWeek(today),
    firstThisMonth: last === null || last.slice(0, 7) !== today.slice(0, 7),
  };
}

/** What the app does with each response; the receiver's README holds the same table. */
export function usagePingOutcome(status: number | null): "sent" | "retry" | "refused" | "retired" {
  if (status !== null && status >= 200 && status < 300) return "sent";
  if (status === 410) return "retired";
  if (status === null || status === 429 || status >= 500) return "retry";
  return "refused";
}

export type UsagePingerDependencies = {
  now(): Date;
  readSettings(): AutomationSettingsFile;
  writeSettings(patch: Record<string, string>): void;
  appVersion(): string;
  systemVersion(): string;
  locale(): "zh-TW" | "en";
  /** When the app's data directory was created, used once to fix the cohort week. */
  firstLaunch(): Date;
  /** Posts the JSON body and returns the HTTP status, or null when no response arrived. */
  send(url: string, body: string): Promise<number | null>;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(timer: unknown): void;
  reportError(message: string): void;
};

export function createUsagePinger(deps: UsagePingerDependencies) {
  let active = false;
  let timer: unknown = null;
  let inFlight: Promise<void> | null = null;
  let refusedDay: string | null = null;

  function cohortWeek(settings: AutomationSettingsFile): string {
    const stored = settings[USAGE_COHORT_WEEK_KEY];
    if (typeof stored === "string" && stored) return stored;
    const week = usageCohortWeek(deps.firstLaunch(), deps.now());
    deps.writeSettings({ [USAGE_COHORT_WEEK_KEY]: week });
    return week;
  }

  /** The payload the next ping would send, shown to the person in Settings. */
  function preview(): UsagePing {
    const settings = deps.readSettings();
    const lastSentDay = settings[USAGE_LAST_SENT_DAY_KEY];
    return buildUsagePing({
      now: deps.now(),
      appVersion: deps.appVersion(),
      systemVersion: deps.systemVersion(),
      locale: deps.locale(),
      cohortWeek: cohortWeek(settings),
      lastSentDay: typeof lastSentDay === "string" && lastSentDay ? lastSentDay : null,
    });
  }

  async function attempt() {
    const settings = deps.readSettings();
    if (!automationFlagEnabled(settings[USAGE_STATISTICS_ENABLED_KEY])) return;
    const today = taipeiDay(deps.now());
    if (settings[USAGE_LAST_SENT_DAY_KEY] === today || refusedDay === today) return;
    const ping = preview();
    let status: number | null;
    try {
      status = await deps.send(USAGE_PING_URL, JSON.stringify(ping, [...USAGE_PING_FIELDS]));
    } catch {
      status = null;
    }
    const outcome = usagePingOutcome(status);
    if (outcome === "sent") deps.writeSettings({ [USAGE_LAST_SENT_DAY_KEY]: today });
    if (outcome === "refused") refusedDay = today;
    if (outcome === "retired") deps.writeSettings({ [USAGE_STATISTICS_ENABLED_KEY]: "false" });
    // Never log the payload.
    if (outcome !== "sent") deps.reportError(`usage-ping-${outcome}${status === null ? "" : `-${status}`}`);
  }

  /** Sends today's ping if it is due and the pinger was started. Concurrent calls share one attempt. */
  function check(): Promise<void> {
    if (!active) return Promise.resolve();
    inFlight ??= attempt()
      .catch(() => deps.reportError("usage-ping-failed"))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    preview,
    check,
    start() {
      active = true;
      // Fix the cohort week at the first launch, whether or not statistics are on.
      cohortWeek(deps.readSettings());
      void check();
      timer ??= deps.setInterval(() => void check(), CHECK_INTERVAL_MS);
    },
    stop() {
      active = false;
      if (timer !== null) deps.clearInterval(timer);
      timer = null;
    },
  };
}

export async function postUsagePing(url: string, body: string): Promise<number | null> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      credentials: "omit",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.status;
  } catch {
    return null;
  }
}
