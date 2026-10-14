import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readAutomationSettingsFile,
  writeAutomationSettingsFile,
} from "../automation/server/config-files.ts";
import {
  systemSettings,
  systemSettingsFileEntries,
  validateSystemSettings,
  type SystemSettingsDto,
} from "./system-settings.ts";

const defaults: SystemSettingsDto = {
  systemTimezone: "Asia/Taipei",
  exchangeRateUpdateTime: "06:00",
  scheduledCollectionEnabled: false,
  scheduledCollectionTime: "07:00",
};
assert.deepEqual(systemSettings({}), defaults, "scheduled collection is opt-in");
assert.equal(systemSettings({ AUTOMATION_BUSINESS_TIMEZONE: "Asia/Tokyo" }).systemTimezone, "Asia/Tokyo");
assert.throws(() => validateSystemSettings({ ...defaults, systemTimezone: "Mars/Base" }));
assert.throws(() => validateSystemSettings({ ...defaults, exchangeRateUpdateTime: "6:00" }));
assert.throws(() => validateSystemSettings({ ...defaults, exchangeRateUpdateTime: "24:00" }));
assert.throws(() => validateSystemSettings({ ...defaults, scheduledCollectionTime: "7:00" }));
assert.throws(() => validateSystemSettings({
  ...defaults,
  scheduledCollectionEnabled: "true" as unknown as boolean,
}));

const settingsDirectory = mkdtempSync(join(tmpdir(), "system-settings-"));
try {
  const settingsPath = join(settingsDirectory, "settings.json");
  for (const saved of [
    { ...defaults, scheduledCollectionEnabled: true, scheduledCollectionTime: "21:45" },
    { ...defaults, scheduledCollectionEnabled: false, scheduledCollectionTime: "05:10" },
  ]) {
    writeAutomationSettingsFile(settingsPath, systemSettingsFileEntries(validateSystemSettings(saved)));
    assert.deepEqual(systemSettings(readAutomationSettingsFile(settingsPath)), saved, "settings file round-trip");
  }
} finally {
  rmSync(settingsDirectory, { recursive: true, force: true });
}

const settingsPageSource = readFileSync(new URL("./SettingsPage.svelte", import.meta.url), "utf8");
assert.match(
  settingsPageSource,
  /\$: timezoneOptions = timezones\.includes\(selectedTimezone\)\s*\? timezones\s*:\s*\[selectedTimezone, \.\.\.timezones\]/,
);
assert.match(settingsPageSource, /\{#each timezoneOptions as timezone\}/);
assert.match(settingsPageSource, /id="settings-save-status"/);
assert.match(settingsPageSource, /id="update-hour"/);
assert.match(settingsPageSource, /id="update-minute"/);
assert.match(settingsPageSource, /const hours = Array\.from\(\{ length: 24 \}/, "the rate time reads in 24-hour form");
assert.doesNotMatch(settingsPageSource, /meridiem/i);
assert.match(settingsPageSource, /scheduleSettings/);
assert.match(settingsPageSource, /languageDisplaySettings/);
assert.doesNotMatch(settingsPageSource, /type="submit"/);
assert.doesNotMatch(settingsPageSource, /linear-gradient/);
assert.doesNotMatch(settingsPageSource, /function chooseLocale\(value: Locale\) \{[^}]*saveStatus = "success";/);
assert.doesNotMatch(settingsPageSource, /function changeDisplayScale\(value: number\) \{[^}]*saveStatus = "success";/);
assert.match(settingsPageSource, /type="range"\s+min=\{DISPLAY_SCALE_MIN\}\s+max=\{DISPLAY_SCALE_MAX\}\s+step=\{DISPLAY_SCALE_STEP\}/);
assert.match(
  settingsPageSource,
  /oninput=\{\(event\) => \(draftScale = Number\(event\.currentTarget\.value\)\)\}\s*onchange=\{\(event\) => \{[^}]*changeDisplayScale\(/,
  "dragging the size slider previews the value and zooms the app only on release",
);
