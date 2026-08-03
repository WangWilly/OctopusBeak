import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packager } from "@electron/packager";

const require = createRequire(import.meta.url);
const forgeConfig = require("../forge.config.cjs");
const electronVersion = require("electron/package.json").version;
const ignored = (path) =>
  forgeConfig.packagerConfig.ignore.some((pattern) => pattern.test(path));

function packagedSourceFiles(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

assert.equal(ignored("/credentials.json"), true);
assert.equal(ignored("/nested/credentials.json"), false);
assert.equal(ignored("/electron/main.cjs"), false);

const root = mkdtempSync(join(tmpdir(), "octopusbeak-package-secret-boundary-"));
const fixture = join(root, "fixture");
const output = join(root, "output");
const runtimeCanaries = [
  "runtime-credential-packaging-canary",
  "runtime-env-packaging-canary",
];

try {
  mkdirSync(fixture);
  writeFileSync(join(fixture, "package.json"), JSON.stringify({
    name: "secret-boundary-probe",
    version: "1.0.0",
    main: "main.cjs",
  }));
  writeFileSync(join(fixture, "main.cjs"), "require('electron').app.quit();\n");
  writeFileSync(join(fixture, "credentials.json"), runtimeCanaries[0]);
  writeFileSync(join(fixture, ".env.local"), runtimeCanaries[1]);

  const [appPath] = await packager({
    ...forgeConfig.packagerConfig,
    dir: fixture,
    out: output,
    name: "SecretBoundaryProbe",
    icon: undefined,
    electronVersion,
    platform: process.platform,
    arch: process.arch,
    overwrite: true,
    prune: false,
    quiet: true,
  });
  const resourcesApp = process.platform === "darwin"
    ? join(appPath, "SecretBoundaryProbe.app", "Contents", "Resources", "app")
    : join(appPath, "resources", "app");
  const packagedResources = packagedSourceFiles(resourcesApp);
  const packagedText = packagedResources.map((path) => readFileSync(path, "utf8")).join("\n");

  assert.equal(packagedResources.some((path) => path.endsWith("main.cjs")), true);
  assert.deepEqual(
    runtimeCanaries.filter((canary) => packagedText.includes(canary)),
    [],
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
