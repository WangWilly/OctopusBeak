import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAutomationSettingsStore, writeAutomationConfigFiles } from "./config-files.ts";
import { watchPreviewVisibility } from "./settings.ts";
import { credentialStoreForCheck } from "./task-run-check-support.ts";

test("every settings write that changes Preview visibility announces it once, and no other write does", () => {
  const directory = mkdtempSync(join(tmpdir(), "octopus-beak-preview-visibility-"));
  const settings = createAutomationSettingsStore(join(directory, "settings.json"));
  try {
    settings.write({ PREVIEW_FEATURES_ENABLED: "false" });
    let changes = 0;
    const unwatch = watchPreviewVisibility(settings, () => { changes += 1; });

    settings.write({ PREVIEW_FEATURES_ENABLED: "true" });
    assert.equal(changes, 1, "turning Preview features on announces a change");

    settings.write({ PREVIEW_FEATURES_ENABLED: "true", SYSTEM_TIMEZONE: "Asia/Taipei" });
    assert.equal(changes, 1, "a write that leaves visibility alone announces nothing");

    writeAutomationConfigFiles(settings, { PREVIEW_FEATURES_ENABLED: "false" }, {
      store: credentialStoreForCheck(join(directory, "credentials.json")),
      credentials: {},
    });
    assert.equal(changes, 2, "the settings-and-credentials write announces its change too");

    writeAutomationConfigFiles(settings, { PREVIEW_FEATURES_ENABLED: "true" });
    assert.equal(changes, 3, "a configuration write without credentials announces its change too");

    createAutomationSettingsStore(join(directory, "other-settings.json")).write({ PREVIEW_FEATURES_ENABLED: "false" });
    assert.equal(changes, 3, "a write to another settings file announces nothing");

    unwatch();
    settings.write({ PREVIEW_FEATURES_ENABLED: "false" });
    assert.equal(changes, 3, "an unwatched write announces nothing");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an invalid settings file does not stop the watch from starting, and the first write announces", () => {
  const directory = mkdtempSync(join(tmpdir(), "octopus-beak-preview-visibility-"));
  const settings = createAutomationSettingsStore(join(directory, "settings.json"));
  try {
    settings.write({ SYSTEM_TIMEZONE: "Mars/Olympus" });
    let changes = 0;
    const unwatch = watchPreviewVisibility(settings, () => { changes += 1; });
    settings.write({ PREVIEW_FEATURES_ENABLED: "false" });
    assert.equal(changes, 1, "with no visibility seen yet, the first write announces");
    unwatch();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
