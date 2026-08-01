import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const nodeVersion = "25.9.0";
const npmVersion = "11.12.1";
const workflowNodeVersion = /node-version:\s+25\.9\.0(?:\s|$)/;

assert.equal(packageJson.packageManager, `npm@${npmVersion}`);
assert.deepEqual(packageJson.devEngines?.packageManager, {
  name: "npm",
  version: npmVersion,
  onFail: "error",
});
assert.equal(
  readFileSync(resolve(root, ".tool-versions"), "utf8"),
  `nodejs ${nodeVersion}\n`,
);

for (const workflow of [
  ".github/workflows/pr-tests.yml",
  ".github/workflows/release-macos.yml",
]) {
  assert.match(
    readFileSync(resolve(root, workflow), "utf8"),
    workflowNodeVersion,
    `${workflow} must use Node ${nodeVersion}`,
  );
}
