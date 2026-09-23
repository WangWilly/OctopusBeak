import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

assert.match(
  source,
  /try\s*{\s*prepareLibrettoRunCdpPatch\(\);\s*}\s*catch\s*\(error\)\s*{\s*console\.warn\("libretto-run-cdp-patch-failed", error\);\s*}/,
);
assert.match(source, /createPGliteOperationalRuntime\(/u);
assert.match(source, /recoverAbandonedAutomationSessions\(operationalRuntime\.provider\)/);
assert.match(source, /hydrateAutomationRuntimeState\(operationalRuntime\.provider\)/);
assert.match(source, /automationRuntimeReady\.then\(\(\) => scheduler\?\.start\(\)\)/);
assert.match(source, /process\.env\.OCTOPUSBEAK_CDP_FIXTURE === "171"/);
assert.match(source, /if \(!cdpFixture\)/);
assert.doesNotMatch(
  source,
  /openLedgerDatabase|migrateLedgerBeforeWindow|initializeCanonicalRuntimeBeforeWindow|ledgerDir|pgliteOperationalEnabled/,
);
