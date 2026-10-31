import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

assert.doesNotMatch(source, /prepareLibrettoRunCdpPatch|libretto-run-cdp-patch-failed/u);
assert.match(source, /createPGliteOperationalRuntime\(/u);
assert.match(source, /const runtime = createAutomationRuntime\(operationalRuntime\.provider\)/);
assert.match(source, /runtime\.recover\(\)[\s\S]*?\.then\(\(\) => resolve\(\)\)/);
assert.match(source, /automationRuntime\?\.abortAll\(\)/u);
assert.match(source, /if \(automationRuntime\?\.hasActive\(\)\) await automationRuntime\.shutdown\(\)/u);
assert.match(
  source,
  /runtime\.runMany\(\["exchange-rates"\], \{ scheduledAtUtc \}\)/,
  "a scheduled exchange-rate run passes the same admission check as every other start",
);
assert.match(
  source,
  /automationRuntimeReady\.then\(\(\) => \{[\s\S]*?scheduler\?\.start\(\);\s*collectionScheduler\?\.start\(\);[\s\S]*?if \(app\.isPackaged && !cdpFixture && !packagedBrowserFixture\) usagePinger\?\.start\(\);\s*appUpdater\?\.start\(\);\s*\}\)/,
);
assert.match(
  source,
  /const handleBeforeQuit = createBeforeQuitHandler\(\{\s*cleanup: async \(\) => \{\s*scheduler\?\.stop\(\);\s*collectionScheduler\?\.stop\(\);/,
);
assert.match(
  source,
  /closeDatabase: async \(\) => \{\s*await pgliteOperationalRuntime\?\.close\(\);\s*\}/,
  "quit waits for the PGlite shutdown checkpoint so the next launch does not replay the WAL",
);
assert.match(
  source,
  /closeDatabaseDeadlineMs: QUIT_CLEANUP_WAIT_MS \+ PGLITE_WORKER_SHUTDOWN_TIMEOUT_MS \+ \d/,
  "the quit deadline leaves the worker its whole shutdown bound after cleanup",
);
assert.match(source, /app\.on\("before-quit", handleBeforeQuit\)/);
assert.match(
  source,
  /hasOccurrenceBeenAttempted:\s*\(occurrenceUtc\)\s*=>\s*operationalRuntime\.provider\.automation\.hasOccurrenceBeenAttempted\(\s*"exchange-rates",\s*occurrenceUtc,?\s*\)/,
);
assert.match(source, /process\.env\.OCTOPUSBEAK_CDP_FIXTURE === "171"/);
assert.match(source, /if \(!cdpFixture && !packagedBrowserFixture\)/);
assert.match(source, /const packagedBrowserFixture = packagedBrowserFixtureEnabled\(process\.env\)/);
assert.match(source, /runPackagedBrowserWorkerFixture\(\s*runtime,\s*userData,\s*process\.env,\s*\)/);
assert.match(source, /PACKAGED_BROWSER_FIXTURE_RESULT_PREFIX/);
assert.doesNotMatch(
  source,
  /openLedgerDatabase|migrateLedgerBeforeWindow|initializeCanonicalRuntimeBeforeWindow|ledgerDir|pgliteOperationalEnabled/,
);
assert.match(
  source,
  /appUpdateSupport\(\{\s*packaged: app\.isPackaged,\s*testFixture: cdpFixture \|\| packagedBrowserFixture,\s*inApplicationsFolder: app\.isPackaged && app\.isInApplicationsFolder\(\),\s*feedFixtureUrl: process\.env\.OCTOPUSBEAK_UPDATE_FEED_FIXTURE,\s*\}\)/,
  "fixtures never check, and a packaged build outside Applications never downloads (app-updates.check.ts covers the decision)",
);
assert.deepEqual(
  source.match(/autoUpdater\.setFeedURL\([^)]*\)/g),
  ["autoUpdater.setFeedURL({ url: handoff.feedUrl, serverType: \"default\" })"],
  "Squirrel.Mac reads only the localhost hand-off, never the public feed",
);
for (const event of ["update-downloaded", "update-not-available", "error"]) {
  assert.match(
    source,
    new RegExp(`autoUpdater\\.on\\("${event}", \\([^)]*\\) => \\{\\s*endSquirrelHandoff\\(\\);`),
    `the hand-off server closes on ${event}`,
  );
}
assert.equal(
  source.match(/autoUpdater\.quitAndInstall\(\)/g)?.length,
  1,
  "only the updater's restart, which refuses while a run is active, installs an update",
);
assert.match(
  source,
  /cleanup: async \(\) => \{[\s\S]*?appUpdater\?\.stop\(\);[\s\S]*?\},\s*cleanupWaitMs/,
  "quitting stops the update timer",
);
const appUpdatesSource = readFileSync(new URL("../src/lib/settings/app-updates.ts", import.meta.url), "utf8");
assert.doesNotMatch(appUpdatesSource, /USAGE_PING|usage-statistics/, "update checks never reach the usage statistics receiver");
