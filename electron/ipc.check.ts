import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { octopusBeakApiChannels } from "../src/lib/desktop/api.ts";

assert.equal(octopusBeakApiChannels.includes("settings:load"), true);
assert.equal(octopusBeakApiChannels.includes("settings:save"), true);

const source = readFileSync(new URL("./ipc.ts", import.meta.url), "utf8");
assert.match(source, /ipcMain\.handle\("settings:load"/);
assert.match(source, /ipcMain\.handle\("settings:save"/);
assert.match(source, /await onSystemSettingsChanged\?\.\(value\)/);

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
assert.match(mainSource, /createExchangeRateScheduler/);
assert.match(mainSource, /onSystemSettingsChanged: scheduler\.reschedule/);
assert.match(mainSource, /scheduler\.start\(\)/);
assert.match(mainSource, /scheduler\?\.stop\(\)/);
assert.match(mainSource, /exchange-rate-scheduler-error/);

const pageSource = readFileSync(new URL("../src/routes/+page.svelte", import.meta.url), "utf8");
assert.match(pageSource, /\.catch\(\(error\) => console\.warn\("system-settings-load-failed", error\)\)/);
assert.match(pageSource, /\.finally\(\(\) => \{\s*initialized = true;\s*normalizeRoute\(\);\s*\}\)/);
