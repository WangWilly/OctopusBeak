import assert from "node:assert/strict";
import { test } from "node:test";

import {
  crc32,
  expectedWelcomeAssetDestinations,
  validateWelcomeAssets,
} from "./welcome-assets.mjs";

const EXPECTED_SCREENSHOT_BASES = ["01-overview", "04-asset", "08-spending"];

const EXPECTED_DESTINATIONS = [
  "src/lib/welcome/assets/app-icon.png",
  "src/lib/welcome/assets/ink-background.png",
  "src/lib/welcome/assets/curved-arrow-animation.svg",
  ...EXPECTED_SCREENSHOT_BASES.map(
    (base) => `src/lib/welcome/assets/screenshots/${base}.png`,
  ),
];

test("CRC-32 matches the published check value", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("Welcome asset delivery exposes exactly the specified destinations", () => {
  assert.deepEqual(expectedWelcomeAssetDestinations(), EXPECTED_DESTINATIONS);
});

test("all Welcome assets are lossless, transparent where required, and LFS-safe", async () => {
  const report = await validateWelcomeAssets();
  assert.equal(report.assetCount, 6);
  assert.equal(report.invalidAssets.length, 0, report.invalidAssets.join("\n"));
});
