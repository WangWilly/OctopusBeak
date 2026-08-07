import assert from "node:assert/strict";
import { test } from "node:test";

import {
  crc32,
  expectedWelcomeAssetDestinations,
  validateWelcomeAssets,
} from "./welcome-assets.mjs";

const EXPECTED_SCREENSHOT_BASES = [
  "01-overview",
  "02-overview-net-change",
  "03-overview-portfolio-flow",
  "04-asset",
  "05-asset-brokerage-trades",
  "06-asset-brokerage-positions",
  "07-liability-changes",
  "08-spending",
  "09-receipt-list",
  "10-receipt-detail",
  "11-credential-settings",
];

const EXPECTED_DESTINATIONS = [
  "src/lib/welcome/assets/app-icon.png",
  "src/lib/welcome/assets/ink-background.png",
  "src/lib/welcome/assets/curved-arrow-animation.svg",
  ...EXPECTED_SCREENSHOT_BASES.flatMap((base) => [
    `src/lib/welcome/assets/screenshots/${base}.en.png`,
    `src/lib/welcome/assets/screenshots/${base}.zh-TW.png`,
  ]),
  ...EXPECTED_SCREENSHOT_BASES.map(
    (base) => `src/lib/welcome/assets/icons/${base}.png`,
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
  assert.equal(report.assetCount, 36);
  assert.equal(report.invalidAssets.length, 0, report.invalidAssets.join("\n"));
});
