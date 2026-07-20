import assert from "node:assert/strict";
import { displayScaleZoomFactor, octopusBeakApiChannels } from "./api.ts";

assert.deepEqual([...octopusBeakApiChannels], [
  "settings:load",
  "settings:save",
  "overview:load",
  "assets:load",
  "liabilities:load",
  "spending:load",
  "spending:updateItemCategory",
  "spending:updateTransactionOverride",
  "automation:load",
  "automation:saveCredentials",
  "automation:run",
  "automation:runMany",
  "automation:resume",
  "automation:cancel",
  "automation:runHistory",
  "automation:viewerScreenshot",
  "automation:viewerInspect",
  "automation:viewerInput",
  "automation:forceQuit",
  "dataIssues:list",
  "dataIssues:create",
  "dataIssues:load",
  "dataIssues:startDiagnosis",
  "dataIssues:previewExclusion",
  "dataIssues:confirmExclusion",
  "dataIssues:previewRestore",
  "dataIssues:confirmRestore",
]);

for (const channel of [
  "dataIssues:list",
  "dataIssues:create",
  "dataIssues:load",
  "dataIssues:startDiagnosis",
  "dataIssues:previewExclusion",
  "dataIssues:confirmExclusion",
  "dataIssues:previewRestore",
  "dataIssues:confirmRestore",
] as const) assert.ok(octopusBeakApiChannels.includes(channel));

import type { OctopusBeakApi } from "./api.ts";

const displayApi: OctopusBeakApi["display"] = {
  setScale(percent) {
    assert.equal(percent, 100);
  },
};
displayApi.setScale(100);

assert.equal(displayScaleZoomFactor(75), 0.75);
assert.equal(displayScaleZoomFactor(100), 1);
assert.equal(displayScaleZoomFactor(150), 1.5);
assert.equal(displayScaleZoomFactor(50), 0.75);
assert.equal(displayScaleZoomFactor(200), 1.5);
assert.throws(
  () => displayScaleZoomFactor(Number.NaN),
  { name: "TypeError", message: "Display scale must be finite." },
);
