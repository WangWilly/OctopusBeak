import assert from "node:assert/strict";
import { octopusBeakApiChannels } from "../src/lib/desktop/api.ts";

assert.equal(octopusBeakApiChannels.includes("automation:run"), true);
assert.equal(octopusBeakApiChannels.includes("automation:cancel"), true);
assert.equal(octopusBeakApiChannels.includes("automation:runHistory"), true);
assert.equal(octopusBeakApiChannels.includes("automation:viewerScreenshot"), true);
