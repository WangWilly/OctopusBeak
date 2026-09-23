import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

assert.match(
  source,
  /try\s*{\s*prepareLibrettoRunCdpPatch\(\);\s*}\s*catch\s*\(error\)\s*{\s*console\.warn\("libretto-run-cdp-patch-failed", error\);\s*}/,
);
assert.match(source, /initializeCanonicalRuntimeBeforeWindow\(userData\)/);
assert.match(
  source,
  /if \(!pgliteOperationalRuntime\)\s*\{\s*initializeCanonicalRuntimeBeforeWindow\(userData\);/u,
  "the enabled PGlite startup path must not initialize canonical.sqlite",
);
assert.match(source, /recoverAbandonedAutomationSessions\(ledgerDir\)/);
assert.match(source, /hydrateAutomationRuntimeState\(ledgerDir\)/);
assert.match(source, /automationRuntimeReady\.then\(\(\) => scheduler\?\.start\(\)\)/);
assert.match(source, /process\.env\.OCTOPUSBEAK_CDP_FIXTURE === "171"/);
assert.match(source, /if \(!cdpFixture\)/);
assert.doesNotMatch(
  source,
  /openLedgerDatabase|migrateLedgerBeforeWindow/,
);
