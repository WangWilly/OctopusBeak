import assert from "node:assert/strict";
import { octopusBeakApiChannels } from "./api.ts";

assert.deepEqual([...octopusBeakApiChannels], [
  "overview:load",
  "assets:load",
  "liabilities:load",
  "automation:load",
  "automation:saveCredentials",
  "automation:run",
  "automation:resume",
  "automation:viewerScreenshot",
  "automation:viewerInspect",
  "automation:viewerInput",
  "automation:forceQuit",
]);
