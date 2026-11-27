import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAutomationCredentialState } from "./automation-desktop-model.ts";
import { automationGroupEnabledStatus } from "./settings.ts";
import { configuredOverviewSources } from "../../overview/server/expected-sources.ts";
import { credentialStoreForCheck, planForCheck, runnerHostForCheck } from "./task-run-check-support.ts";
import { taskById } from "./tasks.ts";

const FUBON_ENABLED = "LIBRETTO_CLOUD_FUBON" + "_ENABLED";
const FUBON_PASSWORD = "LIBRETTO_CLOUD_FUBON" + "_PASSWORD";
const FUBON_STATEMENT_TYPES = "LIBRETTO_CLOUD_FUBON" + "_STATEMENT_TYPES";
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

test("a shell variable named like a setting or credential reaches neither a run's configuration nor its input", () => {
  const directory = mkdtempSync(join(tmpdir(), "no-env-fallback-"));
  try {
    const host = runnerHostForCheck(directory);
    host.settings.write({ [FUBON_STATEMENT_TYPES]: "credit_card" });
    const fubon = taskById("fubon-all-statements")!;
    withShellEnv({
      [FUBON_PASSWORD]: "from-shell",
      [FUBON_ENABLED]: "true",
      [FUBON_STATEMENT_TYPES]: "deposit",
      [PREVIEW_FEATURES]: "true",
    }, () => {
      const plan = planForCheck(fubon, host);
      assert.deepEqual(plan.launchConfiguration, {
        settings: { [FUBON_STATEMENT_TYPES]: "credit_card" },
        credentials: {},
      }, "the configuration holds the stores and nothing from the shell");
      const input = plan.registration.inputFromConfiguration(plan.launchConfiguration) as { statementTypes: unknown };
      assert.deepEqual(input.statementTypes, ["credit_card"], "the stored selection decides, not the shell's");
      assert.doesNotMatch(JSON.stringify(input), /from-shell/u, "a shell credential never reaches the input");

      host.credentials.write({ [FUBON_PASSWORD]: "stored" });
      const stored = planForCheck(fubon, host);
      assert.equal(stored.launchConfiguration.credentials[FUBON_PASSWORD], "stored");
      assert.match(JSON.stringify(stored.registration.inputFromConfiguration(stored.launchConfiguration)), /"stored"/u);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
