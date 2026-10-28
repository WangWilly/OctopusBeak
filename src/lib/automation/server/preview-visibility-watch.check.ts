import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeAutomationConfigFiles, writeAutomationSettings } from "./config-files.ts";
import { watchPreviewVisibility } from "./settings.ts";

test("every settings write that changes Preview visibility announces it once, and no other write does", () => {
  const previous = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "octopus-beak-preview-visibility-"));
  process.chdir(directory);
  try {
    writeAutomationSettings({ PREVIEW_FEATURES_ENABLED: "false" });
    let changes = 0;
    const unwatch = watchPreviewVisibility(() => { changes += 1; });

    writeAutomationSettings({ PREVIEW_FEATURES_ENABLED: "true" });
    assert.equal(changes, 1, "turning Preview features on announces a change");

    writeAutomationSettings({ PREVIEW_FEATURES_ENABLED: "true", SYSTEM_TIMEZONE: "Asia/Taipei" });
    assert.equal(changes, 1, "a write that leaves visibility alone announces nothing");

    writeAutomationConfigFiles({ PREVIEW_FEATURES_ENABLED: "false" }, {});
    assert.equal(changes, 2, "the settings-and-credentials write announces its change too");

    writeAutomationConfigFiles({ PREVIEW_FEATURES_ENABLED: "true" });
    assert.equal(changes, 3, "a configuration write without credentials announces its change too");

    unwatch();
    writeAutomationSettings({ PREVIEW_FEATURES_ENABLED: "false" });
    assert.equal(changes, 3, "an unwatched write announces nothing");
  } finally {
    process.chdir(previous);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an invalid settings file does not stop the watch from starting, and the first write announces", () => {
  const previous = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "octopus-beak-preview-visibility-"));
  process.chdir(directory);
  try {
    writeAutomationSettings({ SYSTEM_TIMEZONE: "Mars/Olympus" });
    let changes = 0;
    const unwatch = watchPreviewVisibility(() => { changes += 1; });
    writeAutomationSettings({ PREVIEW_FEATURES_ENABLED: "false" });
    assert.equal(changes, 1, "with no visibility seen yet, the first write announces");
    unwatch();
  } finally {
    process.chdir(previous);
    rmSync(directory, { recursive: true, force: true });
  }
});
