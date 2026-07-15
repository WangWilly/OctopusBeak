import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { octopusBeakApiChannels } from "../src/lib/desktop/api.ts";

assert.equal(octopusBeakApiChannels.includes("settings:load"), true);
assert.equal(octopusBeakApiChannels.includes("settings:save"), true);

const source = readFileSync(new URL("./ipc.ts", import.meta.url), "utf8");
assert.match(source, /ipcMain\.handle\("settings:load"/);
assert.match(source, /ipcMain\.handle\("settings:save"/);
