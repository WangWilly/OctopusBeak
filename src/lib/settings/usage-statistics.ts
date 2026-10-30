import type { AutomationSettingsFile } from "../automation/server/config-files.ts";
import { automationFlagEnabled } from "../automation/statement-selection.ts";

declare const __OCTOPUSBEAK_USAGE_PING_URL__: string | undefined;

/**
 * ADR 0078: the only request the app makes to a host we operate. The release build sets it from
 * OCTOPUSBEAK_USAGE_PING_URL (electron.vite.config.ts) so the address stays out of the source.
 * Source checkouts, tests and builds without the variable get "", and then nothing is sent or asked.
 */
export const USAGE_PING_URL: string =
  typeof __OCTOPUSBEAK_USAGE_PING_URL__ === "string" ? __OCTOPUSBEAK_USAGE_PING_URL__ : "";

export const USAGE_STATISTICS_ENABLED_KEY = "USAGE_STATISTICS_ENABLED";
/** Set once the person has answered the one-time question, or changed the switch in Settings. */
export const USAGE_STATISTICS_PROMPTED_KEY = "USAGE_STATISTICS_PROMPTED";
/** Set when the receiver answers 410: collection is over, whatever the switch says later. */
export const USAGE_STATISTICS_RETIRED_KEY = "USAGE_STATISTICS_RETIRED";
/** The day a ping was refused with a 4xx that is not retried, so a relaunch does not send again. */
export const USAGE_REFUSED_DAY_KEY = "USAGE_REFUSED_DAY";
export const USAGE_COHORT_WEEK_KEY = "USAGE_COHORT_WEEK";
export const USAGE_LAST_SENT_DAY_KEY = "USAGE_LAST_SENT_DAY";

/** The first release was published on 2026-07-01; no install is older. */
const FIRST_COHORT_WEEK = "2026-W27";
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;
/** Taiwan has no daylight saving time; the receiver cuts days the same way. */
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Exactly the fields ADR 0078 allows, in the order they are sent. */
export const USAGE_PING_FIELDS = [
  "schema",
  "appVersion",
  "osVersion",
  "arch",
  "locale",
  "cohortWeek",
  "firstThisWeek",
  "firstThisMonth",
  "failures",
] as const;

/** The fields of each failure entry. JSON.stringify's key list filters nested objects too. */
const USAGE_FAILURE_FIELDS = ["day", "source", "code", "stage", "count"] as const;

/** Failures counted on one Asia/Taipei day by source (task id), failure code and stage. */
export type UsageFailure = { day: string; source: string; code: string; stage: string; count: number };

/** Local, unsent failure counts: day → "source|code|stage" → count. */
export type UsageFailureBook = Record<string, Record<string, number>>;

/** Failures older than this are dropped; the receiver refuses them too. */
export const USAGE_FAILURE_DAYS = 7;
const MAX_FAILURE_ENTRIES = 50;
const MAX_FAILURE_COUNT = 1000;

export type UsagePing = {
  schema: 2;
  appVersion: string;
  osVersion: string;
  arch: "arm64";
  locale: "zh-TW" | "en";
  cohortWeek: string;
  firstThisWeek: boolean;
  firstThisMonth: boolean;
  failures: UsageFailure[];
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
  failures?: UsageFailure[];
}): UsagePing {
  const today = taipeiDay(input.now);
  const last = input.lastSentDay;
  return {
    schema: 2,
    appVersion: input.appVersion,
    osVersion: usageOsVersion(input.systemVersion),
    arch: "arm64",
    locale: input.locale,
    cohortWeek: input.cohortWeek,
    firstThisWeek: last === null || isoWeek(last) !== isoWeek(today),
    firstThisMonth: last === null || last.slice(0, 7) !== today.slice(0, 7),
    failures: input.failures ?? [],
  };
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Drops days the receiver would refuse. */
export function pruneFailureBook(book: UsageFailureBook, today: string): UsageFailureBook {
  const oldest = addDays(today, -USAGE_FAILURE_DAYS);
  return Object.fromEntries(Object.entries(book).filter(([day]) => day >= oldest && day <= today));
}

export function addFailures(
  book: UsageFailureBook,
  today: string,
  failures: readonly { source: string; code: string; stage: string }[],
): UsageFailureBook {
  const next = pruneFailureBook(book, today);
  const day = { ...next[today] };
  for (const failure of failures) {
    const key = `${failure.source}|${failure.code}|${failure.stage}`;
    day[key] = Math.min(MAX_FAILURE_COUNT, (day[key] ?? 0) + 1);
  }
  return failures.length ? { ...next, [today]: day } : next;
}

/** The entries one ping carries: newest days first, at most 50. */
export function failureEntries(book: UsageFailureBook, today: string): UsageFailure[] {
  return Object.entries(pruneFailureBook(book, today))
    .sort(([left], [right]) => right.localeCompare(left))
    .flatMap(([day, counts]) =>
      Object.entries(counts).map(([key, count]) => {
        const [source, code, stage] = key.split("|");
        return { day, source, code, stage, count: Math.min(MAX_FAILURE_COUNT, count) };
      }),
    )
    .filter((entry) => entry.count > 0)
    .slice(0, MAX_FAILURE_ENTRIES);
}

/** Removes what a delivered ping carried, keeping failures recorded while it was in flight. */
export function subtractFailures(book: UsageFailureBook, sent: readonly UsageFailure[]): UsageFailureBook {
  const next: UsageFailureBook = Object.fromEntries(Object.entries(book).map(([day, counts]) => [day, { ...counts }]));
  for (const entry of sent) {
    const counts = next[entry.day];
    const key = `${entry.source}|${entry.code}|${entry.stage}`;
    if (!counts?.[key]) continue;
    counts[key] -= entry.count;
    if (counts[key] <= 0) delete counts[key];
    if (Object.keys(counts).length === 0) delete next[entry.day];
  }
  return next;
}

/** What the app does with each response; the receiver's README holds the same table. */
export function usagePingOutcome(status: number | null): "sent" | "retry" | "refused" | "retired" {
  if (status !== null && status >= 200 && status < 300) return "sent";
  if (status === 410) return "retired";
  if (status === null || status === 429 || status >= 500) return "retry";
  return "refused";
}

export type UsagePingerDependencies = {
  /** USAGE_PING_URL in the app; "" means this build cannot send. */
  url: string;
  /** Development only: show the one-time question on every launch, whatever was answered before. */
  forceAsk?: boolean;
  now(): Date;
  readSettings(): AutomationSettingsFile;
  writeSettings(patch: Record<string, string>): void;
  appVersion(): string;
  systemVersion(): string;
  locale(): "zh-TW" | "en";
  /** When the app's data directory was created, used once to fix the cohort week. */
  firstLaunch(): Date;
  /** Unsent failure counts, kept beside settings.json. */
  readFailures(): UsageFailureBook;
  writeFailures(book: UsageFailureBook): void;
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
  let answeredThisLaunch = false;

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
      failures: failureEntries(deps.readFailures(), taipeiDay(deps.now())),
    });
  }

  function collecting(settings: AutomationSettingsFile): boolean {
    return Boolean(deps.url)
      && automationFlagEnabled(settings[USAGE_STATISTICS_ENABLED_KEY])
      && !automationFlagEnabled(settings[USAGE_STATISTICS_RETIRED_KEY]);
  }

  /** Counts a finished run's failures for the next ping. Nothing is kept unless statistics are on. */
  function recordFailures(failures: readonly { source: string; code: string; stage: string }[]) {
    if (!failures.length || !collecting(deps.readSettings())) return;
    deps.writeFailures(addFailures(deps.readFailures(), taipeiDay(deps.now()), failures));
  }

  async function attempt() {
    if (!deps.url) return;
    const settings = deps.readSettings();
    if (!collecting(settings)) {
      // Counts kept while statistics were on are not sent once they are off.
      if (Object.keys(deps.readFailures()).length) deps.writeFailures({});
      return;
    }
    const today = taipeiDay(deps.now());
    if (settings[USAGE_LAST_SENT_DAY_KEY] === today || settings[USAGE_REFUSED_DAY_KEY] === today) return;
    const ping = preview();
    let status: number | null;
    try {
      status = await deps.send(deps.url, JSON.stringify(ping, [...USAGE_PING_FIELDS, ...USAGE_FAILURE_FIELDS]));
    } catch {
      status = null;
    }
    const outcome = usagePingOutcome(status);
    if (outcome === "sent") {
      deps.writeSettings({ [USAGE_LAST_SENT_DAY_KEY]: today });
      deps.writeFailures(subtractFailures(deps.readFailures(), ping.failures));
    }
    if (outcome === "refused") deps.writeSettings({ [USAGE_REFUSED_DAY_KEY]: today });
    if (outcome === "retired") {
      deps.writeSettings({
        [USAGE_STATISTICS_RETIRED_KEY]: "true",
        [USAGE_STATISTICS_ENABLED_KEY]: "false",
        [USAGE_STATISTICS_PROMPTED_KEY]: "true",
      });
      deps.writeFailures({});
    }
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

  /** True when the one-time question should be shown: this build can send, and the person has neither opted in nor answered. */
  function shouldAsk(): boolean {
    if (deps.forceAsk) return !answeredThisLaunch;
    if (!deps.url) return false;
    const settings = deps.readSettings();
    if (automationFlagEnabled(settings[USAGE_STATISTICS_RETIRED_KEY])) return false;
    return !automationFlagEnabled(settings[USAGE_STATISTICS_ENABLED_KEY])
      && !automationFlagEnabled(settings[USAGE_STATISTICS_PROMPTED_KEY]);
  }

  /** Records the answer to the one-time question; a yes sends today's ping if it is due. */
  function answer(enabled: boolean) {
    answeredThisLaunch = true;
    deps.writeSettings({
      [USAGE_STATISTICS_ENABLED_KEY]: enabled ? "true" : "false",
      [USAGE_STATISTICS_PROMPTED_KEY]: "true",
    });
    if (!enabled) deps.writeFailures({});
    void check();
  }

  return {
    preview,
    check,
    recordFailures,
    shouldAsk,
    answer,
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
      // A redirect must not carry the body to another host.
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.status;
  } catch {
    return null;
  }
}
