import assert from "node:assert/strict";
import { get } from "svelte/store";
import { applySystemSettings, systemTimezone } from "./system-timezone-store.ts";

assert.equal(get(systemTimezone), "Asia/Taipei");
applySystemSettings({
  systemTimezone: "Asia/Tokyo",
  exchangeRateUpdateTime: "07:30",
});
assert.equal(get(systemTimezone), "Asia/Tokyo");
