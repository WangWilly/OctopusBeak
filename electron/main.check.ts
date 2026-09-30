import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

assert.doesNotMatch(source, /prepareLibrettoRunCdpPatch|libretto-run-cdp-patch-failed/u);
assert.match(source, /createPGliteOperationalRuntime\(/u);
assert.match(source, /recoverInterruptedAutomationRuns\(operationalRuntime\.provider\)/);
assert.match(source, /hydrateAutomationRuntimeState\(operationalRuntime\.provider\)/);
assert.match(
  source,
  /recoverInterruptedAutomationRuns\(operationalRuntime\.provider\)[\s\S]*?\.then\(\(\) => hydrateAutomationRuntimeState\(operationalRuntime\.provider\)\)[\s\S]*?\.then\(\(\) => resolve\(\)\)/,
);
assert.match(source, /abortActiveAppWorkflowExecutions\(\)/u);
assert.match(source, /shutdownAppAutomationWorkflows\(pgliteOperationalRuntime\.provider\)/u);
assert.match(
  source,
  /automationRuntimeReady\.then\(\(\) => \{[\s\S]*?scheduler\?\.start\(\);\s*\}\)/,
);
assert.match(
  source,
  /const handleBeforeQuit = createBeforeQuitHandler\(\{\s*cleanup: async \(\) => \{\s*scheduler\?\.stop\(\);/,
);
assert.match(source, /app\.on\("before-quit", handleBeforeQuit\)/);
assert.match(
  source,
  /hasOccurrenceBeenAttempted:\s*\(occurrenceUtc\)\s*=>\s*operationalRuntime\.provider\.automation\.hasOccurrenceBeenAttempted\(\s*"exchange-rates",\s*occurrenceUtc,?\s*\)/,
);
assert.match(source, /process\.env\.OCTOPUSBEAK_CDP_FIXTURE === "171"/);
assert.match(source, /if \(!cdpFixture && !packagedBrowserFixture\)/);
assert.match(source, /const packagedBrowserFixture = packagedBrowserFixtureEnabled\(process\.env\)/);
assert.match(source, /runPackagedBrowserWorkerFixture\(\s*operationalRuntime\.provider,\s*userData,\s*process\.env,\s*\)/);
assert.match(source, /PACKAGED_BROWSER_FIXTURE_RESULT_PREFIX/);
assert.doesNotMatch(
  source,
  /openLedgerDatabase|migrateLedgerBeforeWindow|initializeCanonicalRuntimeBeforeWindow|ledgerDir|pgliteOperationalEnabled/,
);
