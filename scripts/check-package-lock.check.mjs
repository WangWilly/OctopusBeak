import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("scripts/check-package-lock.mjs");
const fixtureRoot = mkdtempSync(join(tmpdir(), "package-lock-check-"));

try {
  const lockPath = join(fixtureRoot, "package-lock.json");
  writeFileSync(
    lockPath,
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/parent": {
          version: "1.0.0",
          optionalDependencies: { optional: "^1.0.0" },
        },
      },
    }),
  );
  const optionalMissing = spawnSync(process.execPath, [script], {
    cwd: fixtureRoot,
    encoding: "utf8",
  });
  assert.equal(optionalMissing.status, 1);
  assert.match(optionalMissing.stderr, /missing optionalDependencies optional@\^1\.0\.0/);

  writeFileSync(
    lockPath,
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/parent": {
          version: "1.0.0",
          dependencies: { required: "^1.0.0" },
        },
      },
    }),
  );
  const requiredMissing = spawnSync(process.execPath, [script], {
    cwd: fixtureRoot,
    encoding: "utf8",
  });
  assert.equal(requiredMissing.status, 1);
  assert.match(requiredMissing.stderr, /missing dependencies required@\^1\.0\.0/);
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
