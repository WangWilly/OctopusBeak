import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const startSource = source.slice(source.indexOf("async function start()"));

assert.match(
  source,
  /try\s*{\s*prepareLibrettoRunCdpPatch\(\);\s*}\s*catch\s*\(error\)\s*{\s*console\.warn\("libretto-run-cdp-patch-failed", error\);\s*}/,
);

assert.ok(
  startSource.indexOf("registerAutomationCredentialSafeStorage();")
    < startSource.indexOf("recoverAbandonedAutomationSessions()"),
  "released startup must install the encrypted credential writer before recovery",
);

assert.match(
  source,
  /const agentProvider = process\.platform === "darwin"[\s\S]*createAppleSystemModelProtocolClient[\s\S]*createUnsupportedAppleSystemModelProvider\(process\.platform\)/,
);
