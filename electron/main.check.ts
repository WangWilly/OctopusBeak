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
  /automationRuntimeReady\.then\(\(\) => \{[\s\S]*?scheduler\?\.start\(\);\s*collectionScheduler\?\.start\(\);\s*\}\)/,
);
assert.match(
  source,
  /const handleBeforeQuit = createBeforeQuitHandler\(\{\s*cleanup: async \(\) => \{\s*scheduler\?\.stop\(\);\s*collectionScheduler\?\.stop\(\);/,
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
