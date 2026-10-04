import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { systemSettings, validateSystemSettings } from "./system-settings.ts";

assert.deepEqual(systemSettings({}), {
  systemTimezone: "Asia/Taipei",
  exchangeRateUpdateTime: "06:00",
});
assert.equal(systemSettings({ AUTOMATION_BUSINESS_TIMEZONE: "Asia/Tokyo" }).systemTimezone, "Asia/Tokyo");
assert.throws(() => validateSystemSettings({ systemTimezone: "Mars/Base", exchangeRateUpdateTime: "06:00" }));
assert.throws(() => validateSystemSettings({ systemTimezone: "Asia/Taipei", exchangeRateUpdateTime: "6:00" }));
assert.throws(() => validateSystemSettings({ systemTimezone: "Asia/Taipei", exchangeRateUpdateTime: "24:00" }));

const settingsPageSource = readFileSync(new URL("./SettingsPage.svelte", import.meta.url), "utf8");
assert.match(
  settingsPageSource,
  /\$: timezoneOptions = timezones\.includes\(selectedTimezone\)\s*\? timezones\s*:\s*\[selectedTimezone, \.\.\.timezones\]/,
);
assert.match(settingsPageSource, /\{#each timezoneOptions as timezone\}/);
assert.match(settingsPageSource, /id="settings-save-status"/);
assert.match(settingsPageSource, /id="update-hour"/);
assert.match(settingsPageSource, /id="update-minute"/);
assert.match(settingsPageSource, /id="update-meridiem"/);
assert.match(settingsPageSource, /scheduleSettings/);
assert.match(settingsPageSource, /languageDisplaySettings/);
assert.doesNotMatch(settingsPageSource, /type="submit"/);
assert.doesNotMatch(settingsPageSource, /linear-gradient/);
assert.doesNotMatch(settingsPageSource, /display-scale-shortcuts kbd/);
assert.doesNotMatch(settingsPageSource, /function chooseLocale\(value: Locale\) \{[^}]*saveStatus = "success";/);
assert.doesNotMatch(settingsPageSource, /function changeDisplayScale\(value: number\) \{[^}]*saveStatus = "success";/);
assert.match(settingsPageSource, /aria-label=\{\$t\.settings\.decreaseScale\}[\s\S]*?disabled=\{\$displayScale <= DISPLAY_SCALE_MIN\}/);
assert.match(settingsPageSource, /aria-label=\{\$t\.settings\.increaseScale\}[\s\S]*?disabled=\{\$displayScale >= DISPLAY_SCALE_MAX\}/);
