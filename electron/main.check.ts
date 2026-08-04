import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AppleSystemModelProtocolError,
  createAppleSystemModelProvider,
  type AppleSystemModelProtocolClient,
} from "../src/lib/agent/server/apple-system-model-provider.ts";
import { readHostOsBuild } from "./host-os-build.ts";

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

test("host OS build lookup is bounded and preserves valid trimmed output", () => {
  const exec = (output: string) => () => output;
  assert.equal(readHostOsBuild(exec("  25C56\n")), "25C56");
  assert.equal(readHostOsBuild(exec("  \n")), "unknown");
  assert.equal(readHostOsBuild(() => { throw new Error("sw_vers unavailable"); }), "unknown");
  assert.equal(readHostOsBuild(() => { throw new Error("sw_vers exited with code 1"); }), "unknown");
});

test("provider protocol failure keeps its reason when host OS diagnostics are unavailable", async () => {
  const protocolFailure = new AppleSystemModelProtocolError(
    "incompatible-protocol",
    "helper protocol mismatch",
  );
  const client = {
    async activate() {
      throw protocolFailure;
    },
  } as unknown as AppleSystemModelProtocolClient;

  const activation = await createAppleSystemModelProvider({
    client,
    hostOsBuild: () => readHostOsBuild(() => { throw new Error("sw_vers unavailable"); }),
  }).activate();

  assert.deepEqual(activation, {
    availability: "incompatible",
    providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
    osBuild: "unknown",
    reason: "helper-protocol-incompatible",
  });
});
