import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };
const forgeConfig = require("../forge.config.cjs") as {
  packagerConfig: { extraResource?: string[]; ignore?: RegExp[] };
};

assert.equal(
  packageJson.scripts["build:apple-system-model-helper"],
  "node scripts/build-apple-system-model-helper.mjs",
);
assert.match(packageJson.scripts.build, /build:apple-system-model-helper/);
assert.deepEqual(
  forgeConfig.packagerConfig.extraResource,
  process.platform === "darwin"
    ? ["build-helpers/apple-system-model-helper"]
    : [],
);
assert.equal(
  forgeConfig.packagerConfig.ignore?.some((pattern) => (
    pattern.test("/build-helpers/apple-system-model-helper")
    && pattern.test("/build-helpers/module-cache/FoundationModels.swiftmodule")
  )),
  true,
);
