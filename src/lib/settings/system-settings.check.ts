import assert from "node:assert/strict";
import { systemSettings, validateSystemSettings } from "./system-settings.ts";

assert.deepEqual(systemSettings({}), {
  systemTimezone: "Asia/Taipei",
  exchangeRateUpdateTime: "06:00",
});
assert.equal(systemSettings({ AUTOMATION_BUSINESS_TIMEZONE: "Asia/Tokyo" }).systemTimezone, "Asia/Tokyo");
assert.throws(() => validateSystemSettings({ systemTimezone: "Mars/Base", exchangeRateUpdateTime: "06:00" }));
assert.throws(() => validateSystemSettings({ systemTimezone: "Asia/Taipei", exchangeRateUpdateTime: "6:00" }));
assert.throws(() => validateSystemSettings({ systemTimezone: "Asia/Taipei", exchangeRateUpdateTime: "24:00" }));
