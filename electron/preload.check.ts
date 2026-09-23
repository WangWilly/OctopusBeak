import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { octopusBeakApiChannels } from "../src/lib/desktop/api.ts";

assert.equal(octopusBeakApiChannels.includes("automation:run"), true);
assert.equal(octopusBeakApiChannels.includes("automation:runMany"), true);
assert.equal(octopusBeakApiChannels.includes("automation:cancel"), true);
assert.equal(octopusBeakApiChannels.includes("automation:runHistory"), true);
assert.equal(octopusBeakApiChannels.includes("automation:viewerScreenshot"), true);
assert.equal(octopusBeakApiChannels.includes("automation:cathayGmailOtpStatus"), true);
assert.equal(octopusBeakApiChannels.includes("automation:enableCathayGmailOtp"), true);
assert.equal(octopusBeakApiChannels.includes("automation:setCathayGmailOtpEnabled"), true);
assert.equal(octopusBeakApiChannels.includes("automation:disconnectCathayGmailOtp"), true);
assert.equal(octopusBeakApiChannels.includes("data:getVersion"), true);
assert.equal(octopusBeakApiChannels.includes("data:acknowledgeVersion"), true);
assert.equal(octopusBeakApiChannels.includes("data:invalidated"), true);

const source = readFileSync(new URL("./preload.ts", import.meta.url), "utf8");
assert.deepEqual(
  [...source.matchAll(/^import (?!type\b)[\s\S]*? from "([^"]+)";/gm)].map((match) => match[1]),
  ["electron"],
  "sandboxed preload must stay self-contained after bundling",
);
for (const [method, channel] of [
  ["cathayGmailOtpStatus", "automation:cathayGmailOtpStatus"],
  ["enableCathayGmailOtp", "automation:enableCathayGmailOtp"],
  ["setCathayGmailOtpEnabled", "automation:setCathayGmailOtpEnabled"],
  ["disconnectCathayGmailOtp", "automation:disconnectCathayGmailOtp"],
]) {
  assert.match(source, new RegExp(`${method}: .*ipcRenderer\\.invoke\\("${channel}"`));
}
assert.match(source, /getVersion: .*ipcRenderer\.invoke\("data:getVersion"/);
assert.match(source, /acknowledgeVersion: .*ipcRenderer\.invoke\("data:acknowledgeVersion"/);
assert.match(source, /onInvalidated\(listener\)/);
assert.match(source, /ipcRenderer\.on\("data:invalidated"/);
assert.match(source, /const dataViews = \{/);
for (const channel of ["data-views:subscribe", "data-views:enabled", "data-views:unsubscribe", "data-views:rows", "data-views:error"]) {
  assert.match(source, new RegExp(channel.replace(/[-:]/gu, "[-:]")));
}
assert.match(source, /dataViews,/);
