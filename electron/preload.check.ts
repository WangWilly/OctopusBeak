import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { octopusBeakApiChannels } from "../src/lib/desktop/api.ts";

assert.equal(octopusBeakApiChannels.includes("automation:run"), true);
assert.equal(octopusBeakApiChannels.includes("automation:runMany"), true);
assert.equal(octopusBeakApiChannels.includes("automation:cancel"), true);
assert.equal(octopusBeakApiChannels.includes("automation:runHistory"), true);
assert.equal(octopusBeakApiChannels.includes("automation:viewerScreenshot"), true);
assert.equal(octopusBeakApiChannels.includes("financialFreshness:changed"), true);
assert.equal(octopusBeakApiChannels.includes("financialFreshness:latestKnowledgePoint"), true);
assert.equal(octopusBeakApiChannels.includes("financialFreshness:reconnected"), true);
assert.equal(octopusBeakApiChannels.includes("overview:section:load"), true);
assert.equal(octopusBeakApiChannels.includes("assets:section:load"), true);
assert.equal(octopusBeakApiChannels.includes("liabilities:section:load"), true);
assert.equal(octopusBeakApiChannels.includes("spending:section:load"), true);
assert.equal(octopusBeakApiChannels.includes("automation:cathayGmailOtpStatus"), true);
assert.equal(octopusBeakApiChannels.includes("automation:enableCathayGmailOtp"), true);
assert.equal(octopusBeakApiChannels.includes("automation:setCathayGmailOtpEnabled"), true);
assert.equal(octopusBeakApiChannels.includes("automation:disconnectCathayGmailOtp"), true);

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
assert.match(source, /financialFreshness:\s*\{/);
assert.match(source, /ipcRenderer\.on\("financialFreshness:changed"/);
assert.match(source, /ipcRenderer\.removeListener\("financialFreshness:changed", onEvent\)/);
assert.match(source, /ipcRenderer\.invoke\(\s*"financialFreshness:latestKnowledgePoint"/);
assert.match(source, /ipcRenderer\.on\("financialFreshness:reconnected"/);
assert.match(source, /ipcRenderer\.removeListener\("financialFreshness:reconnected", onEvent\)/);
assert.match(source, /financialFreshnessEventFrom/);
assert.match(source, /financial:\s*\{/);
assert.match(source, /ipcRenderer\.invoke\(\s*"financial:cancel"/);
assert.match(source, /financialPageRequestTokenFrom/);
for (const [route, channel] of [
  ["overview", "overview:load"],
  ["assets", "assets:load"],
  ["liabilities", "liabilities:load"],
  ["spending", "spending:load"],
]) {
  assert.match(
    source,
    new RegExp(`load: \\(input, options\\) => ipcRenderer\\.invoke\\(\\"${channel}\\",`),
    `${route} preload load must forward its input to IPC`,
  );
}
for (const [route, channel] of [
  ["overview", "overview:section:load"],
  ["assets", "assets:section:load"],
  ["liabilities", "liabilities:section:load"],
  ["spending", "spending:section:load"],
]) {
  assert.match(
    source,
    new RegExp(`loadSection: \\(section, input, options\\)[\\s\\S]*?\\"${channel}\\"`),
    `${route} preload section load must cross its IPC channel`,
  );
}
assert.match(source, /Financial section must be primary or secondary/);
assert.match(source, /financialPageLoadInputFrom\(input\)/);
assert.match(source, /spendingLoadInputFrom\(input\)/);
assert.match(source, /Financial query cutoff must contain a non-negative safe integer knowledge point/);
