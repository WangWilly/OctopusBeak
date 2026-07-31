import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("scripts/check-actions-pinned.mjs");
const fixtureRoot = mkdtempSync(join(tmpdir(), "actions-pinned-"));

try {
  const workflowDir = join(fixtureRoot, ".github", "workflows");
  mkdirSync(workflowDir, { recursive: true });
  const workflowPath = join(workflowDir, "test.yml");

  writeFileSync(
    workflowPath,
    "jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v6\n",
  );
  const unsafe = spawnSync(process.execPath, [script, fixtureRoot], {
    encoding: "utf8",
  });
  assert.equal(unsafe.status, 1);
  assert.match(unsafe.stderr, /test\.yml:4.*actions\/checkout@v6/);

  writeFileSync(
    workflowPath,
    "jobs:\n  test:\n    steps:\n      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567 # v6\n",
  );
  execFileSync(process.execPath, [script, fixtureRoot], { stdio: "pipe" });

  writeFileSync(
    workflowPath,
    "jobs:\n  test:\n    steps:\n      - { \"uses\": actions/checkout@v6 }\n",
  );
  const unsafeFlowMapping = spawnSync(
    process.execPath,
    [script, fixtureRoot],
    { encoding: "utf8" },
  );
  assert.equal(unsafeFlowMapping.status, 1);
  assert.match(unsafeFlowMapping.stderr, /test\.yml.*actions\/checkout@v6/);

  writeFileSync(
    workflowPath,
    [
      "env:",
      "  uses: harmless-value",
      "jobs:",
      "  test:",
      "    steps:",
      "      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567",
      "",
    ].join("\n"),
  );
  execFileSync(process.execPath, [script, fixtureRoot], { stdio: "pipe" });

  writeFileSync(
    workflowPath,
    [
      "env:",
      "  CHECKOUT_ACTION: &checkout actions/checkout@v6",
      "jobs:",
      "  test:",
      "    steps:",
      "      - uses: *checkout",
      "",
    ].join("\n"),
  );
  const unsafeAlias = spawnSync(process.execPath, [script, fixtureRoot], {
    encoding: "utf8",
  });
  assert.equal(unsafeAlias.status, 1);
  assert.match(unsafeAlias.stderr, /test\.yml.*actions\/checkout@v6/);

  writeFileSync(
    workflowPath,
    "jobs:\n  test:\n    steps:\n      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567\n",
  );
  const compositeDir = join(fixtureRoot, ".github", "actions", "fixture");
  mkdirSync(compositeDir, { recursive: true });
  const compositePath = join(compositeDir, "action.yml");
  writeFileSync(
    compositePath,
    "runs:\n  using: composite\n  steps:\n    - uses: actions/setup-node@v4\n",
  );
  const unsafeComposite = spawnSync(
    process.execPath,
    [script, fixtureRoot],
    { encoding: "utf8" },
  );
  assert.equal(unsafeComposite.status, 1);
  assert.match(unsafeComposite.stderr, /action\.yml.*actions\/setup-node@v4/);

  writeFileSync(
    compositePath,
    "runs:\n  using: composite\n  steps:\n    - uses: actions/setup-node@0123456789abcdef0123456789abcdef01234567\n",
  );
  execFileSync(process.execPath, [script, resolve(".")], { stdio: "pipe" });
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
