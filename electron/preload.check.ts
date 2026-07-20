import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { octopusBeakApiChannels } from "../src/lib/desktop/api.ts";

assert.equal(octopusBeakApiChannels.includes("automation:run"), true);
assert.equal(octopusBeakApiChannels.includes("automation:runMany"), true);
assert.equal(octopusBeakApiChannels.includes("automation:cancel"), true);
assert.equal(octopusBeakApiChannels.includes("automation:runHistory"), true);
assert.equal(octopusBeakApiChannels.includes("automation:viewerScreenshot"), true);

const source = readFileSync(new URL("./preload.ts", import.meta.url), "utf8");
assert.deepEqual(
  [...source.matchAll(/^import (?!type\b)[\s\S]*? from "([^"]+)";/gm)].map((match) => match[1]),
  ["electron"],
  "sandboxed preload must stay self-contained after bundling",
);
for (const method of [
  ["list", "dataIssues:list"],
  ["create", "dataIssues:create"],
  ["load", "dataIssues:load"],
  ["startDiagnosis", "dataIssues:startDiagnosis"],
  ["previewExclusion", "dataIssues:previewExclusion"],
  ["confirmExclusion", "dataIssues:confirmExclusion"],
  ["previewRestore", "dataIssues:previewRestore"],
  ["confirmRestore", "dataIssues:confirmRestore"],
]) {
  assert.match(source, new RegExp(`${method[0]}: .*ipcRenderer\\.invoke\\("${method[1]}"`));
}
