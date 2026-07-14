import assert from "node:assert/strict";
import { octopusBeakApiChannels } from "./api.ts";

assert.deepEqual([...octopusBeakApiChannels], [
  "overview:load",
  "assets:load",
  "liabilities:load",
  "spending:load",
  "spending:updateItemCategory",
  "automation:load",
  "automation:saveCredentials",
  "automation:run",
  "automation:resume",
  "automation:cancel",
  "automation:runHistory",
  "automation:viewerScreenshot",
  "automation:viewerInspect",
  "automation:viewerInput",
  "automation:forceQuit",
]);

import type { OctopusBeakApi } from "./api.ts";

const displayApi: OctopusBeakApi["display"] = {
  setScale(percent) {
    assert.equal(percent, 100);
  },
};
displayApi.setScale(100);
