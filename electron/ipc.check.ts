import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { octopusBeakApiChannels } from "../src/lib/desktop/api.ts";

assert.equal(octopusBeakApiChannels.includes("settings:load"), true);
assert.equal(octopusBeakApiChannels.includes("settings:save"), true);

const source = readFileSync(new URL("./ipc.ts", import.meta.url), "utf8");
assert.match(source, /ipcMain\.handle\("settings:load"/);
assert.match(source, /ipcMain\.handle\("settings:save"/);

const pageSource = readFileSync(new URL("../src/routes/+page.svelte", import.meta.url), "utf8");
assert.match(pageSource, /\.catch\(\(error\) => console\.warn\("system-settings-load-failed", error\)\)/);
assert.match(pageSource, /\.finally\(\(\) => \{\s*initialized = true;\s*normalizeRoute\(\);\s*\}\)/);
