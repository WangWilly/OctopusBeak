import assert from "node:assert/strict";
import test from "node:test";
import { readAutomationCredentialState } from "./automation-desktop-model.ts";
import { automationConfigEnv } from "./config-files.ts";
import { automationGroupEnabledStatus } from "./settings.ts";
import { configuredOverviewSources } from "../../overview/server/expected-sources.ts";
import { credentialStoreForCheck } from "./task-run-check-support.ts";

const FUBON_ENABLED = "LIBRETTO_CLOUD_FUBON" + "_ENABLED";
const FUBON_PASSWORD = "LIBRETTO_CLOUD_FUBON" + "_PASSWORD";
const PREVIEW_FEATURES = "PREVIEW_FEATURES_ENABLED";

/** Sets shell variables for one test the way a launching terminal would, then restores them. */
function withShellEnv(values: Record<string, string>, run: () => void) {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("a shell variable does not enable a bank group the settings leave off", () => {
  withShellEnv({ [FUBON_ENABLED]: "true" }, () => {
    assert.equal(automationGroupEnabledStatus({}).fubon, false);
    assert.equal(configuredOverviewSources({}).some((source) => source.sourceId === "fubon"), false);
  });
});

test("a shell variable does not count as a saved credential", () => {
  withShellEnv({ [FUBON_PASSWORD]: "from-shell" }, () => {
    const state = readAutomationCredentialState(credentialStoreForCheck(), { [FUBON_ENABLED]: true });
    assert.equal(state.status[FUBON_PASSWORD], false, "only the credential store decides what is saved");
  });
});

test("a workflow's environment takes stored values only", () => {
  withShellEnv({ [FUBON_PASSWORD]: "from-shell", [FUBON_ENABLED]: "true", [PREVIEW_FEATURES]: "true" }, () => {
    const env = automationConfigEnv({ settings: {}, credentials: {} });
    assert.deepEqual(env, {}, "nothing from the launching shell is passed on");
    const stored = automationConfigEnv({
      settings: { [FUBON_ENABLED]: true },
      credentials: { [FUBON_PASSWORD]: "stored" },
    });
    assert.equal(stored[FUBON_PASSWORD], "stored");
    assert.equal(stored[FUBON_ENABLED], "true");
  });
});
