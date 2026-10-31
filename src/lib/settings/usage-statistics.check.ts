import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AutomationSettingsFile } from "../automation/server/config-files.ts";
import { runFailures } from "../automation/server/task-run-finished.ts";
import {
  addFailures,
  buildUsagePing,
  failureEntries,
  subtractFailures,
  createUsagePinger,
  isoWeek,
  taipeiDay,
  usageCohortWeek,
  usageOsVersion,
  usagePingOutcome,
  USAGE_PING_FIELDS,
  USAGE_PING_URL,
  type UsageFailureBook,
  type UsagePingerDependencies,
} from "./usage-statistics.ts";

const TEST_URL = "https://usage.example.test/v1/ping";

function harness(initial: AutomationSettingsFile, statuses: (number | null)[] = [204], url = TEST_URL, forceAsk = false) {
  let settings: AutomationSettingsFile = { ...initial };
  let book: UsageFailureBook = {};
  const sent: { url: string; body: string }[] = [];
  const errors: string[] = [];
  let now = new Date("2026-10-29T02:00:00Z");
  const deps: UsagePingerDependencies = {
    url,
    forceAsk,
    now: () => now,
    readSettings: () => settings,
    readFailures: () => book,
    writeFailures: (next) => {
      book = next;
    },
    writeSettings: (patch) => {
      settings = { ...settings, ...patch };
    },
    appVersion: () => "0.9.5",
    systemVersion: () => "15.4.1",
    locale: () => "zh-TW",
    firstLaunch: () => new Date("2026-10-20T03:00:00Z"),
    send: async (url, body) => {
      sent.push({ url, body });
      return statuses.length > 1 ? statuses.shift()! : statuses[0];
    },
    setInterval: () => "timer",
    clearInterval: () => {},
    reportError: (message) => errors.push(message),
  };
  return {
    pinger: createUsagePinger(deps),
    sent,
    errors,
    settings: () => settings,
    book: () => book,
    setNow: (value: string) => {
      now = new Date(value);
    },
  };
}

test("the payload carries exactly the allowed fields", () => {
  const ping = buildUsagePing({
    now: new Date("2026-10-29T02:00:00Z"),
    appVersion: "0.9.5",
    systemVersion: "15.4.1",
    locale: "en",
    cohortWeek: "2026-W43",
    lastSentDay: "2026-10-28",
  });
  assert.deepEqual(Object.keys(ping), [...USAGE_PING_FIELDS]);
  assert.deepEqual(ping, {
    schema: 2,
    appVersion: "0.9.5",
    osVersion: "15.4",
    arch: "arm64",
    locale: "en",
    cohortWeek: "2026-W43",
    firstThisWeek: false,
    firstThisMonth: false,
    failures: [],
  });
});

test("week and month flags follow the last day a ping was sent, in Asia/Taipei", () => {
  const flags = (now: string, lastSentDay: string | null) => {
    const ping = buildUsagePing({ now: new Date(now), appVersion: "1.0.0", systemVersion: "15.0", locale: "en", cohortWeek: "2026-W44", lastSentDay });
    return [ping.firstThisWeek, ping.firstThisMonth];
  };
  assert.deepEqual(flags("2026-10-29T02:00:00Z", null), [true, true]);
  assert.deepEqual(flags("2026-10-29T02:00:00Z", "2026-10-27"), [false, false]);
  // Monday 2026-11-02 in Taipei starts at 2026-11-01T16:00Z.
  assert.deepEqual(flags("2026-11-01T16:30:00Z", "2026-10-31"), [true, true]);
  assert.deepEqual(flags("2026-11-01T15:30:00Z", "2026-10-30"), [false, true]);
});

test("time helpers and bounds match the receiver", () => {
  assert.equal(taipeiDay(new Date("2026-10-29T15:59:59Z")), "2026-10-29");
  assert.equal(taipeiDay(new Date("2026-10-29T16:00:00Z")), "2026-10-30");
  assert.equal(isoWeek("2027-01-03"), "2026-W53");
  assert.equal(isoWeek("2027-01-04"), "2027-W01");
  assert.equal(usageCohortWeek(new Date("2025-01-01T00:00:00Z"), new Date("2026-10-29T00:00:00Z")), "2026-W27");
  assert.equal(usageCohortWeek(new Date("2027-01-01T00:00:00Z"), new Date("2026-10-29T00:00:00Z")), "2026-W44");
  assert.equal(usageOsVersion("26.0"), "26.0");
  assert.equal(usageOsVersion("15"), "15.0");
});

test("responses decide whether the day is done, retried, refused, or collection ends", () => {
  assert.equal(usagePingOutcome(204), "sent");
  assert.equal(usagePingOutcome(429), "retry");
  assert.equal(usagePingOutcome(503), "retry");
  assert.equal(usagePingOutcome(null), "retry");
  assert.equal(usagePingOutcome(400), "refused");
  assert.equal(usagePingOutcome(410), "retired");
});

test("nothing is sent unless the person turned statistics on", async () => {
  const off = harness({});
  off.pinger.start();
  await off.pinger.check();
  assert.equal(off.sent.length, 0);
  assert.equal(off.settings().USAGE_COHORT_WEEK, "2026-W43", "the cohort week is fixed at first launch either way");
});

test("an unstarted pinger never sends, even when statistics are on", async () => {
  const unstarted = harness({ USAGE_STATISTICS_ENABLED: "true" });
  await unstarted.pinger.check();
  assert.equal(unstarted.sent.length, 0);
});

test("one ping per day, retried after a temporary failure", async () => {
  const run = harness({ USAGE_STATISTICS_ENABLED: "true" }, [503, 204]);
  run.pinger.start();
  await run.pinger.check();
  assert.equal(run.settings().USAGE_LAST_SENT_DAY, undefined);
  assert.deepEqual(run.errors, ["usage-ping-retry-503"]);
  await run.pinger.check();
  await run.pinger.check();
  assert.equal(run.sent.length, 2);
  assert.equal(run.sent[0].url, TEST_URL);
  assert.equal(run.settings().USAGE_LAST_SENT_DAY, "2026-10-29");
  assert.deepEqual(JSON.parse(run.sent[1].body), {
    schema: 2,
    appVersion: "0.9.5",
    osVersion: "15.4",
    arch: "arm64",
    locale: "zh-TW",
    cohortWeek: "2026-W43",
    firstThisWeek: true,
    firstThisMonth: true,
    failures: [],
  });

  run.setNow("2026-10-30T02:00:00Z");
  await run.pinger.check();
  assert.equal(run.sent.length, 3);
  assert.equal(JSON.parse(run.sent[2].body).firstThisWeek, false);
});

test("a refused ping waits for the next day; 410 turns statistics off", async () => {
  const refused = harness({ USAGE_STATISTICS_ENABLED: "true" }, [400]);
  refused.pinger.start();
  await refused.pinger.check();
  await refused.pinger.check();
  assert.equal(refused.sent.length, 1);
  assert.equal(refused.settings().USAGE_REFUSED_DAY, "2026-10-29", "a relaunch reads the refusal too");
  refused.setNow("2026-10-30T02:00:00Z");
  await refused.pinger.check();
  assert.equal(refused.sent.length, 2, "the next day tries again");

  const retired = harness({ USAGE_STATISTICS_ENABLED: "true" }, [410]);
  retired.pinger.start();
  await retired.pinger.check();
  assert.equal(retired.settings().USAGE_STATISTICS_ENABLED, "false");
  await retired.pinger.check();
  assert.equal(retired.sent.length, 1);
  assert.equal(retired.settings().USAGE_STATISTICS_RETIRED, "true");
  assert.equal(retired.pinger.shouldAsk(), false, "a retired endpoint is never asked about again");
  // A Settings save from a renderer that still shows "On" must not revive collection.
  retired.pinger.answer(true);
  await retired.pinger.check();
  assert.equal(retired.sent.length, 1);
});

test("errors never carry the payload", async () => {
  const run = harness({ USAGE_STATISTICS_ENABLED: "true" }, [null]);
  run.pinger.start();
  await run.pinger.check();
  assert.deepEqual(run.errors, ["usage-ping-retry"]);
});

test("a build without the endpoint neither sends nor asks", async () => {
  assert.equal(USAGE_PING_URL, "", "source checkouts and tests carry no endpoint");
  const run = harness({ USAGE_STATISTICS_ENABLED: "true" }, [204], "");
  run.pinger.start();
  await run.pinger.check();
  assert.equal(run.sent.length, 0);
  assert.equal(harness({}, [204], "").pinger.shouldAsk(), false);
});

test("the question is asked once, until an answer is recorded", async () => {
  const declined = harness({});
  assert.equal(declined.pinger.shouldAsk(), true);
  declined.pinger.answer(false);
  assert.equal(declined.settings().USAGE_STATISTICS_PROMPTED, "true");
  assert.equal(declined.settings().USAGE_STATISTICS_ENABLED, "false");
  assert.equal(declined.pinger.shouldAsk(), false);

  const accepted = harness({});
  accepted.pinger.start();
  await accepted.pinger.check();
  assert.equal(accepted.sent.length, 0);
  accepted.pinger.answer(true);
  await accepted.pinger.check();
  assert.equal(accepted.sent.length, 1, "a yes sends today's ping");
  assert.equal(accepted.pinger.shouldAsk(), false);

  assert.equal(harness({ USAGE_STATISTICS_ENABLED: "true" }).pinger.shouldAsk(), false, "people who already opted in are not asked");
});

test("no source file carries the endpoint or reads its build constant", () => {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const self = "src/lib/settings/usage-statistics.ts";
  const offenders: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:ts|cjs|mjs|js|svelte)$/u.test(entry.name) && !/\.check\.ts$/u.test(entry.name)) {
        const file = relative(root, path).split("\\").join("/");
        const source = readFileSync(path, "utf8");
        if (/workers\.dev|octopusbeak-telemetry/u.test(source)) offenders.push(file);
        if (file !== self && source.includes("__OCTOPUSBEAK_USAGE_PING_URL__")) offenders.push(file);
      }
    }
  };
  for (const directory of ["src", "electron"]) walk(join(root, directory));
  assert.deepEqual(offenders, []);
});

test("the development switch asks again until answered in this launch", () => {
  const forced = harness({ USAGE_STATISTICS_PROMPTED: "true", USAGE_STATISTICS_ENABLED: "true" }, [204], "", true);
  assert.equal(forced.pinger.shouldAsk(), true, "even without an endpoint and after an earlier answer");
  forced.pinger.answer(false);
  assert.equal(forced.pinger.shouldAsk(), false);
});

test("a finished run counts once if it failed, per failed product if partial, never if cancelled", () => {
  const events = [
    { runId: "r", occurredAt: "2026-10-29T02:00:00Z", stage: "authentication", outcome: "failed", code: "x" },
    { runId: "r", occurredAt: "2026-10-29T02:00:01Z", stage: "finalization", outcome: "completed", code: "y" },
  ] as never;
  assert.deepEqual(
    runFailures({ taskId: "esun-credit-card-statements", status: "failed", events, appWorkflowOutcome: { errorCode: "source-unavailable", summary: null } }),
    [{ source: "esun-credit-card-statements", code: "source-unavailable", stage: "authentication" }],
  );
  assert.deepEqual(runFailures({ taskId: "a", status: "failed", events: [], appWorkflowOutcome: { errorCode: "cancelled", summary: null } }), []);
  assert.deepEqual(runFailures({ taskId: "a", status: "cancelled", events, appWorkflowOutcome: null }), []);
  const products = [
    { typeId: "deposit", status: "failed", itemCount: 0, committedCount: 0, errorCode: "source-collection-failed" },
    { typeId: "loan", status: "success", itemCount: 1, committedCount: 1 },
  ];
  assert.deepEqual(
    runFailures({ taskId: "fubon-all-statements", status: "partial", events, appWorkflowOutcome: { errorCode: null, summary: { counts: {}, products } } as never }),
    [{ source: "fubon-all-statements", code: "source-collection-failed", stage: "unknown" }],
  );
});

test("failure counts are kept a week, capped at 50 entries, and only what was sent is removed", () => {
  const failure = { source: "esun-credit-card-statements", code: "source-unavailable", stage: "authentication" };
  let book = addFailures({}, "2026-10-20", [failure]);
  book = addFailures(book, "2026-10-29", [failure, failure]);
  assert.deepEqual(failureEntries(book, "2026-10-29"), [{ day: "2026-10-29", ...failure, count: 2 }], "the 2026-10-20 day is too old");
  const sent = failureEntries(book, "2026-10-29");
  book = addFailures(book, "2026-10-29", [failure]);
  assert.deepEqual(subtractFailures(book, sent), { "2026-10-29": { [`${failure.source}|${failure.code}|${failure.stage}`]: 1 } });
  const many = addFailures({}, "2026-10-29", Array.from({ length: 60 }, (_, index) => ({ ...failure, source: `s${index}` })));
  assert.equal(failureEntries(many, "2026-10-29").length, 50);
});

test("failures are recorded only while statistics are on, sent in the ping, and cleared when turned off", async () => {
  const off = harness({});
  off.pinger.recordFailures([{ source: "a", code: "b", stage: "c" }]);
  assert.deepEqual(off.book(), {}, "nothing is kept while statistics are off");

  const run = harness({ USAGE_STATISTICS_ENABLED: "true" });
  // Failures recorded after today's ping wait for tomorrow's; here the ping has not gone out yet.
  run.pinger.recordFailures([{ source: "esun-credit-card-statements", code: "source-unavailable", stage: "authentication" }]);
  assert.equal(run.pinger.preview().failures.length, 1, "Settings shows the failures the next ping carries");
  run.pinger.start();
  await run.pinger.check();
  const body = JSON.parse(run.sent[0].body);
  assert.deepEqual(body.failures, [
    { day: "2026-10-29", source: "esun-credit-card-statements", code: "source-unavailable", stage: "authentication", count: 1 },
  ]);
  assert.deepEqual(run.book(), {}, "a delivered ping removes what it carried");

  run.pinger.recordFailures([{ source: "a", code: "b", stage: "c" }]);
  run.pinger.answer(false);
  assert.deepEqual(run.book(), {});
});
