import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AutomationSettingsFile } from "../automation/server/config-files.ts";
import {
  buildUsagePing,
  createUsagePinger,
  isoWeek,
  taipeiDay,
  usageCohortWeek,
  usageOsVersion,
  usagePingOutcome,
  USAGE_PING_FIELDS,
  USAGE_PING_URL,
  type UsagePingerDependencies,
} from "./usage-statistics.ts";

function harness(initial: AutomationSettingsFile, statuses: (number | null)[] = [204]) {
  let settings: AutomationSettingsFile = { ...initial };
  const sent: { url: string; body: string }[] = [];
  const errors: string[] = [];
  let now = new Date("2026-10-29T02:00:00Z");
  const deps: UsagePingerDependencies = {
    now: () => now,
    readSettings: () => settings,
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
    schema: 1,
    appVersion: "0.9.5",
    osVersion: "15.4",
    arch: "arm64",
    locale: "en",
    cohortWeek: "2026-W43",
    firstThisWeek: false,
    firstThisMonth: false,
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
  assert.equal(run.sent[0].url, USAGE_PING_URL);
  assert.equal(run.settings().USAGE_LAST_SENT_DAY, "2026-10-29");
  assert.deepEqual(JSON.parse(run.sent[1].body), {
    schema: 1,
    appVersion: "0.9.5",
    osVersion: "15.4",
    arch: "arm64",
    locale: "zh-TW",
    cohortWeek: "2026-W43",
    firstThisWeek: true,
    firstThisMonth: true,
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

  const retired = harness({ USAGE_STATISTICS_ENABLED: "true" }, [410]);
  retired.pinger.start();
  await retired.pinger.check();
  assert.equal(retired.settings().USAGE_STATISTICS_ENABLED, "false");
  await retired.pinger.check();
  assert.equal(retired.sent.length, 1);
});

test("errors never carry the payload", async () => {
  const run = harness({ USAGE_STATISTICS_ENABLED: "true" }, [null]);
  run.pinger.start();
  await run.pinger.check();
  assert.deepEqual(run.errors, ["usage-ping-retry"]);
});

test("only this module names the usage endpoint", () => {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const host = new URL(USAGE_PING_URL).host.split(".")[0];
  const self = "src/lib/settings/usage-statistics.ts";
  const offenders: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:ts|cjs|mjs|js|svelte)$/u.test(entry.name) && !/\.check\.ts$/u.test(entry.name)) {
        const file = relative(root, path).split("\\").join("/");
        if (file !== self && readFileSync(path, "utf8").includes(host)) offenders.push(file);
      }
    }
  };
  for (const directory of ["src", "electron"]) walk(join(root, directory));
  assert.deepEqual(offenders, []);
});
