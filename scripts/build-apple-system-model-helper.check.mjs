import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const scriptUrl = new URL("./build-apple-system-model-helper.mjs", import.meta.url);
const script = fileURLToPath(scriptUrl);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function createDarwinBuildWrapper(tempPath, targetScriptUrl = scriptUrl) {
  const wrapper = join(tempPath, "run-build-as-darwin.mjs");
  const targetScriptPath = fileURLToPath(targetScriptUrl);
  writeFileSync(wrapper, [
    'Object.defineProperty(process, "platform", { value: "darwin" });',
    'process.stdout.write(`simulated-platform:${process.platform}\\n`);',
    `await import(${JSON.stringify(pathToFileURL(targetScriptPath).href)});`,
  ].join("\n"));
  return wrapper;
}

function runBuildWithDarwinPlatform(tempPath, targetScriptUrl = scriptUrl) {
  return spawnSync(process.execPath, [createDarwinBuildWrapper(tempPath, targetScriptUrl)], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, PATH: tempPath },
  });
}

test("helper build reports a deterministic diagnostic when xcrun cannot launch", () => {
  const tempPath = mkdtempSync(join(tmpdir(), "apple-system-model-build-no-xcrun-"));
  try {
    const result = runBuildWithDarwinPlatform(tempPath);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /simulated-platform:darwin/);
    assert.doesNotMatch(result.stdout, /Skipped Apple system model helper build on non-macOS/);
    assert.match(
      result.stderr,
      /Apple system model helper build failed to launch xcrun: spawnSync xcrun ENOENT/,
    );
    assert.doesNotMatch(result.stderr, /TypeError|ERR_INVALID_ARG_TYPE/);
  } finally {
    rmSync(tempPath, { recursive: true, force: true });
  }
});

test("helper build preserves compiler stderr and exit status", () => {
  const tempPath = mkdtempSync(join(tmpdir(), "apple-system-model-build-compiler-failure-"));
  try {
    const fakeXcrun = join(tempPath, "xcrun");
    writeFileSync(fakeXcrun, `#!${process.execPath}\nprocess.stderr.write('compiler diagnostic\\n');\nprocess.exit(7);\n`);
    chmodSync(fakeXcrun, 0o755);
    const result = runBuildWithDarwinPlatform(tempPath);
    assert.equal(result.status, 7);
    assert.match(result.stdout, /simulated-platform:darwin/);
    assert.doesNotMatch(result.stdout, /Skipped Apple system model helper build on non-macOS/);
    assert.match(result.stderr, /compiler diagnostic/);
  } finally {
    rmSync(tempPath, { recursive: true, force: true });
  }
});

test("Darwin build wrapper imports a production script from a path containing spaces", () => {
  const tempPath = mkdtempSync(join(tmpdir(), "apple system model build spaces "));
  try {
    const scriptsPath = join(tempPath, "fixture root", "scripts");
    mkdirSync(scriptsPath, { recursive: true });
    const scriptWithSpaces = join(scriptsPath, "build helper.mjs");
    writeFileSync(scriptWithSpaces, readFileSync(script));
    const fakeXcrun = join(tempPath, "xcrun");
    writeFileSync(fakeXcrun, `#!${process.execPath}\nprocess.stderr.write('space-path diagnostic\\n');\nprocess.exit(7);\n`);
    chmodSync(fakeXcrun, 0o755);

    const result = runBuildWithDarwinPlatform(tempPath, pathToFileURL(scriptWithSpaces));
    assert.equal(result.status, 7);
    assert.match(result.stdout, /simulated-platform:darwin/);
    assert.match(result.stderr, /space-path diagnostic/);
    assert.doesNotMatch(result.stderr, /Cannot find module|ERR_INVALID_ARG_TYPE/);
  } finally {
    rmSync(tempPath, { recursive: true, force: true });
  }
});
