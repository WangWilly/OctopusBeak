import assert from "node:assert/strict";
import { get } from "svelte/store";
import {
  applySystemSettings,
  appUpdatesAutoDownload,
  appUpdatesEnabled,
  previewFeaturesEnabled,
  scheduledCollection,
  systemTimezone,
  usageStatisticsEnabled,
} from "./system-timezone-store.ts";

assert.equal(get(systemTimezone), "Asia/Taipei");
assert.deepEqual(get(scheduledCollection), { enabled: false, time: "07:00" });
assert.equal(get(previewFeaturesEnabled), false, "preview features start off");
assert.equal(get(usageStatisticsEnabled), false, "usage statistics start off");
assert.equal(get(appUpdatesEnabled), true, "update checks start on");
assert.equal(get(appUpdatesAutoDownload), false, "update downloads start off");
applySystemSettings({
  systemTimezone: "Asia/Tokyo",
  exchangeRateUpdateTime: "07:30",
  scheduledCollectionEnabled: true,
  scheduledCollectionTime: "08:15",
  previewFeaturesEnabled: true,
  usageStatisticsEnabled: true,
  appUpdatesEnabled: false,
  appUpdatesAutoDownload: true,
});
assert.equal(get(previewFeaturesEnabled), true);
assert.equal(get(usageStatisticsEnabled), true);
assert.equal(get(appUpdatesEnabled), false);
assert.equal(get(appUpdatesAutoDownload), true);
assert.equal(get(systemTimezone), "Asia/Tokyo");
assert.deepEqual(get(scheduledCollection), { enabled: true, time: "08:15" });
