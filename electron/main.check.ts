import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

assert.doesNotMatch(source, /prepareLibrettoRunCdpPatch|libretto-run-cdp-patch-failed/u);
assert.match(source, /createPGliteOperationalRuntime\(/u);
assert.match(
  source,
  /const cardIdentityVerifierPath = path\.join\(userData, CARD_IDENTITY_VERIFIER_FILE\);[\s\S]*?openSafeStorageCredentialStore\(\s*path\.join\(userData, AUTOMATION_CREDENTIALS_FILE\),\s*cardIdentityVerifierPath,\s*\)[\s\S]*?const ledgerDataDir = path\.join\(userData, "data", "pglite"\);\s*const operationalRuntime = createPGliteOperationalRuntime\(\{\s*dataDir: ledgerDataDir,\s*cardIdentityVerifierPath,/u,
  "startup records the Card identity secret's verifier where the ledger worker reads it",
);
assert.match(
  source,
  /applyOctopusBeakAppIdentity\(app\);[\s\S]*?const ownsUserData = app\.requestSingleInstanceLock\(\);\s*if \(!ownsUserData\) app\.quit\(\);/u,
  "the single-instance lock is taken on the final userData path, before anything opens the ledger",
);
assert.match(
  source,
  /if \(ownsUserData\) app\.whenReady\(\)\.then\(start\)/u,
  "a second process never starts, so two PGlite instances never open one data directory",
);
assert.doesNotMatch(source, /process\.chdir/u, "main opens every App file at an absolute path, so no thread depends on the cwd");
assert.match(
  source,
  /const automationSettings = createAutomationSettingsStore\(path\.join\(userData, AUTOMATION_SETTINGS_FILE\)\);\s*migrateAutomationEnvFile\(\{ envPath: path\.join\(userData, "\.env"\), settings: automationSettings, credentials \}\);\s*migrateStatementSelectionIds\(automationSettings\.path\);/u,
  "the legacy .env in user data migrates into the one settings store before anything reads settings",
);
assert.match(
  source,
  /const runtime = createAutomationRuntime\(operationalRuntime\.provider, \{\s*credentials,\s*settings: automationSettings,\s*userDataDirectory: userData,\s*\}\)/,
);
assert.match(source, /runtime\.recover\(\)[\s\S]*?\.then\(\(\) => resolve\(\)\)/);
assert.match(
  source,
  /operationalRuntime\.worker\.ready\s*\.then\(\(\) => runtime\.recover\(\)\)/u,
  "a ledger that refuses to open fails startup before recovery reads it",
);
assert.match(
  source,
  /const recoverLedger = \(error: unknown\) => \{\s*if \(ledgerRecoveryPending \|\| automationRuntimeFatalHandled\) return;\s*ledgerRecoveryPending = true;[\s\S]*?recoverUnusableLedger\(ledgerDataDir,[\s\S]*?operationalRuntime\.worker\.onError\(\(error\) => \{\s*if \(isLedgerUnusable\(error\)\) recoverLedger\(error\);\s*\}\);\s*void automationRuntimeReady\.catch\(\(error\) => \{[\s\S]*?if \(isLedgerUnusable\(error\)\) \{\s*recoverLedger\(error\);/u,
  "an unusable ledger, at startup or after a restart mid-session, asks the person what to do instead of ending the App",
);
assert.match(
  source,
  /if \(automationRuntimeFatalHandled \|\| ledgerRecoveryPending\) return;/u,
  "no other fatal report ends the App while the person is choosing",
);
assert.match(source, /automationRuntime\?\.abortAll\(\)/u);
assert.match(source, /if \(automationRuntime\?\.hasActive\(\)\) await automationRuntime\.shutdown\(\)/u);
assert.match(
  source,
  /runtime\.start\(\["exchange-rates"\], \{ scheduledAtUtc \}\)/,
  "a scheduled exchange-rate run passes the same admission check as every other start",
);
// host-services.check.ts covers when the background services start, take settings, pause and stop;
// main only hands them recovery's readiness and stops them first on quit.
assert.match(source, /services\.startWhenReady\(automationRuntimeReady\)/u);
assert.match(source, /const handleBeforeQuit = createBeforeQuitHandler\(\{\s*cleanup: async \(\) => \{\s*hostServices\?\.stop\(\);/u);
assert.match(
  source,
  /run: \{\s*schedules: !cdpFixture && !packagedBrowserFixture,\s*usagePing: app\.isPackaged && !cdpFixture && !packagedBrowserFixture,\s*\}/u,
  "fixtures run no schedules, and only a packaged app pings",
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
// squirrel-update-handoff.check.ts covers the hand-off itself.
assert.doesNotMatch(source, /autoUpdater\./, "main only hands autoUpdater to the Squirrel hand-off");
assert.deepEqual(
  source.match(/squirrelHandoff\.quitAndInstall\b.*/g),
  ["squirrelHandoff.quitAndInstall,"],
  "only the updater's restart, which refuses while a run is active, installs an update",
);
const appUpdatesSource = readFileSync(new URL("../src/lib/settings/app-updates.ts", import.meta.url), "utf8");
assert.doesNotMatch(appUpdatesSource, /USAGE_PING|usage-statistics/, "update checks never reach the usage statistics receiver");
