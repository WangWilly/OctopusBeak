import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  readRequiredBrowserDirectories,
  packagedHeadlessShellExecutable,
  playwrightBrowserRoot,
} = require("./desktop-browser-payload.cjs");
const WORKFLOW_FIXTURE_RESULT_PREFIX = "OCTOPUSBEAK_PACKAGED_BROWSER_FIXTURE_RESULT ";
const PLAYWRIGHT_FIXTURE_ERROR_PREFIX = "OCTOPUSBEAK_PACKAGED_PLAYWRIGHT_FIXTURE_ERROR ";
const INHERITED_APP_ENVIRONMENT = [
  "PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "SYSTEMROOT", "WINDIR",
  "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH",
];

function inheritedEnvironment() {
  return Object.fromEntries(INHERITED_APP_ENVIRONMENT.flatMap((name) =>
    typeof process.env[name] === "string" ? [[name, process.env[name]]] : []
  ));
}

function parseAppRoot(args) {
  const index = args.indexOf("--app-root");
  if (index < 0 || !args[index + 1]) {
    throw new Error("Usage: npm run desktop:packaged-browser-smoke -- --app-root <packaged-app-or-resources-app>");
  }
  return resolve(args[index + 1]);
}

function packagedLayout(inputPath) {
  const normalized = inputPath.replaceAll("\\", "/");
  if (normalized.endsWith(".app")) {
    const appBundle = inputPath;
    return {
      appRoot: join(appBundle, "Contents", "Resources", "app"),
      executable: join(appBundle, "Contents", "MacOS", "OctopusBeak"),
      packageRoot: appBundle,
    };
  }

  const appRoot = inputPath;
  if (normalized.endsWith("/Contents/Resources/app")) {
    const contentsRoot = resolve(appRoot, "..", "..");
    return { appRoot, executable: join(contentsRoot, "MacOS", "OctopusBeak"), packageRoot: contentsRoot };
  }

  if (normalized.endsWith("/resources/app")) {
    const distributionRoot = resolve(appRoot, "..", "..");
    const executableName = process.platform === "win32" ? "OctopusBeak.exe" : "OctopusBeak";
    return { appRoot, executable: join(distributionRoot, executableName), packageRoot: distributionRoot };
  }

  return { appRoot, executable: "", packageRoot: "" };
}

function assertContainedPath(rootPath, targetPath, description) {
  try {
    const root = realpathSync(rootPath);
    const target = realpathSync(targetPath);
    const pathFromRoot = relative(root, target);
    if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
      throw new Error();
    }
  } catch {
    throw new Error(`${description} must resolve inside the supplied packaged App.`);
  }
}

function startLocalFixture() {
  let requestCount = 0;
  const server = createServer((request, response) => {
    if (request.url !== "/") {
      response.writeHead(404).end();
      return;
    }
    requestCount += 1;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>OctopusBeak browser fixture</title><main id=fixture>local-browser-ok</main>");
  });
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Local browser fixture did not bind a TCP port."));
        return;
      }
      resolvePromise({ server, url: `http://127.0.0.1:${address.port}/`, get requestCount() { return requestCount; } });
    });
  });
}

function runPackagedPlaywrightNode(runnerPath, environment, timeoutMs = 30_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [runnerPath], {
      cwd: process.cwd(),
      env: {
        ...inheritedEnvironment(),
        ...environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let pendingStderr = "";
    let fixtureError;
    const consumeStderr = (line) => {
      if (line.startsWith(PLAYWRIGHT_FIXTURE_ERROR_PREFIX)) {
        try {
          const parsed = JSON.parse(line.slice(PLAYWRIGHT_FIXTURE_ERROR_PREFIX.length));
          if (parsed && typeof parsed.name === "string" && (parsed.code === null || typeof parsed.code === "string")) {
            fixtureError = { name: parsed.name, code: parsed.code };
          }
        } catch {
          fixtureError = undefined;
        }
        return;
      }
      const safeNodeError = line.match(/^(?<name>[A-Za-z]*Error)(?: \[(?<code>[A-Z0-9_]+)\])?:/u);
      if (safeNodeError?.groups) {
        fixtureError = { name: safeNodeError.groups.name, code: safeNodeError.groups.code ?? null };
      }
    };
    const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      const lines = `${pendingStderr}${String(chunk)}`.split(/\r?\n/u);
      pendingStderr = lines.pop() ?? "";
      for (const line of lines) consumeStderr(line);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Could not start packaged Playwright Node fixture: ${error.name}`));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (pendingStderr) consumeStderr(pendingStderr);
      if (code !== 0) {
        reject(new Error(
          `Packaged browser fixture exited with status ${code ?? signal ?? "unknown"}; ` +
          `error ${fixtureError?.name ?? "unknown"}/${fixtureError?.code ?? "no-code"}.`,
        ));
        return;
      }
      try {
        const lines = stdout.trim().split("\n");
        resolvePromise(JSON.parse(lines.at(-1) ?? ""));
      } catch {
        reject(new Error("Packaged browser fixture returned no valid sanitized result."));
      }
    });
  });
}

function runPackagedWorkflowFixture(electronPath, environment, timeoutMs = 300_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(electronPath, [], {
      cwd: dirname(electronPath),
      env: {
        ...inheritedEnvironment(),
        ...environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let pendingLine = "";
    let resultLine;
    let duplicateResult = false;
    let timedOut = false;
    let killTimer;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeoutMs);
    const consumeLine = (line) => {
      const normalizedLine = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!normalizedLine.startsWith(WORKFLOW_FIXTURE_RESULT_PREFIX)) return;
      if (resultLine !== undefined) {
        duplicateResult = true;
        return;
      }
      resultLine = normalizedLine.slice(WORKFLOW_FIXTURE_RESULT_PREFIX.length);
    };
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      for (const line of `${pendingLine}${chunk}`.split("\n").slice(0, -1)) consumeLine(line);
      pendingLine = `${pendingLine}${chunk}`.split("\n").at(-1) ?? "";
      if (pendingLine.length > 4096) pendingLine = "";
    });
    child.stderr.setEncoding("utf8").on("data", () => {});
    child.once("error", (error) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      reject(new Error(`Could not start packaged App fixture: ${error.name}`));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      consumeLine(pendingLine);
      if (timedOut) {
        reject(new Error("Packaged App worker fixture exceeded its time limit."));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Packaged App worker fixture exited with status ${code ?? signal ?? "unknown"}.`));
        return;
      }
      if (duplicateResult || typeof resultLine !== "string") {
        reject(new Error("Packaged App worker fixture returned an invalid sanitized result."));
        return;
      }
      try {
        resolvePromise(JSON.parse(resultLine));
      } catch {
        reject(new Error("Packaged App worker fixture returned malformed sanitized JSON."));
      }
    });
  });
}

function assertWorkflowFixtureResult(result, expectedVersion) {
  assert.deepEqual(Object.keys(result).sort(), ["cancel", "status", "success"]);
  assert.equal(result.status, "passed");
  const expectedMajor = expectedVersion.split(".")[0];
  const cases = [
    ["success", "completed"],
    ["cancel", "cancelled"],
  ];
  for (const [caseName, expectedStatus] of cases) {
    const outcome = result[caseName];
    assert.deepEqual(Object.keys(outcome).sort(), [
      "actualBrowserVersion", "browserContextClosed", "browserRuntime", "hostPageReleased", "navigatorChromeMajor",
      "navigatorChromeVersion", "recordSanitized", "runtimeProfileDirectoryRemoved", "status",
    ]);
    assert.equal(outcome.status, expectedStatus);
    assert.deepEqual(outcome.browserRuntime, {
      profileId: "default",
      profileRevision: 1,
      chromiumVersion: expectedVersion,
    });
    assert.equal(outcome.actualBrowserVersion, expectedVersion);
    assert.equal(outcome.navigatorChromeVersion, expectedVersion);
    assert.equal(outcome.navigatorChromeMajor, Number(expectedMajor));
    assert.equal(outcome.browserContextClosed, true);
    assert.equal(outcome.hostPageReleased, true);
    assert.equal(outcome.runtimeProfileDirectoryRemoved, true);
    assert.equal(outcome.recordSanitized, true);
  }
}

const inputPath = parseAppRoot(process.argv.slice(2));
const { appRoot, executable, packageRoot } = packagedLayout(inputPath);
const browserRoot = playwrightBrowserRoot(appRoot);
const requiredPayload = readRequiredBrowserDirectories(appRoot);
const headlessShellExecutable = packagedHeadlessShellExecutable(appRoot);
const actualPayload = existsSync(browserRoot)
  ? readdirSync(browserRoot).sort()
  : [];
assert.deepEqual(actualPayload, requiredPayload, "Packaged browser directory must contain exactly the manifest's headless payload.");
if (!executable || !existsSync(executable)) {
  throw new Error("Packaged Electron executable was not found for the supplied App root.");
}
assertContainedPath(packageRoot, appRoot, "Packaged app root");
assertContainedPath(packageRoot, executable, "Packaged Electron executable");
assertContainedPath(appRoot, browserRoot, "Packaged browser payload");
assertContainedPath(browserRoot, headlessShellExecutable, "Packaged Chromium headless-shell executable");
const shellExecutableInfo = lstatSync(headlessShellExecutable);
if (!shellExecutableInfo.isFile() || shellExecutableInfo.isSymbolicLink()) {
  throw new Error("Packaged Chromium headless-shell executable must be a real file.");
}
for (const name of requiredPayload) {
  const payloadPath = join(browserRoot, name);
  if (!lstatSync(payloadPath).isDirectory() || lstatSync(payloadPath).isSymbolicLink()) {
    throw new Error("Packaged browser payload directories must be real directories.");
  }
  assertContainedPath(appRoot, payloadPath, "Packaged browser payload");
}

const browserMetadataPath = join(dirname(createRequire(join(appRoot, "package.json")).resolve("playwright-core")), "browsers.json");
const browserMetadata = JSON.parse(readFileSync(browserMetadataPath, "utf8"));
const expectedVersion = browserMetadata.browsers.find((browser) => browser.name === "chromium")?.browserVersion;
assert.equal(typeof expectedVersion, "string", "Packaged Chromium version must be declared by Playwright.");

const temporaryRoot = mkdtempSync(join(tmpdir(), "octopusbeak-packaged-browser-smoke-"));
const runnerPath = join(temporaryRoot, "smoke.cjs");
const userDataRoot = join(temporaryRoot, "user-data");
const fixture = await startLocalFixture();
let workflowFixtureResult;
try {
  writeFileSync(runnerPath, `
const { createRequire } = require("node:module");
(async () => {
  let browser;
  try {
    const appRoot = process.env.OCTOPUSBEAK_PACKAGED_APP_ROOT;
    const fixtureUrl = process.env.OCTOPUSBEAK_PACKAGED_FIXTURE_URL;
    const executablePath = process.env.OCTOPUSBEAK_PACKAGED_CHROMIUM_EXECUTABLE;
    const appRequire = createRequire(require("node:path").join(appRoot, "package.json"));
    const { chromium } = appRequire("playwright");
    browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage();
    const response = await page.goto(fixtureUrl, { waitUntil: "domcontentloaded" });
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const chromeMajor = userAgent.match(/(?:Chrome|Chromium)\\/(\\d+)\\./u)?.[1] ?? null;
    const result = {
      status: response?.status() ?? null,
      title: await page.title(),
      fixtureMarker: await page.locator("#fixture").textContent(),
      chromiumVersion: browser.version(),
      navigatorChromeMajor: chromeMajor,
    };
    await browser.close();
    result.browserClosed = !browser.isConnected();
    process.stdout.write(JSON.stringify(result) + "\\n");
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    const name = error instanceof Error ? error.name : "unknown";
    const code = error && typeof error.code === "string" ? error.code : null;
    process.stderr.write("${PLAYWRIGHT_FIXTURE_ERROR_PREFIX}" + JSON.stringify({ name, code }) + "\\n");
    process.exitCode = 1;
  }
})();
`, "utf8");

  const result = await runPackagedPlaywrightNode(runnerPath, {
    OCTOPUSBEAK_PACKAGED_APP_ROOT: appRoot,
    OCTOPUSBEAK_PACKAGED_FIXTURE_URL: fixture.url,
    OCTOPUSBEAK_PACKAGED_CHROMIUM_EXECUTABLE: headlessShellExecutable,
    PLAYWRIGHT_BROWSERS_PATH: browserRoot,
  });
  assert.deepEqual(result, {
    status: 200,
    title: "OctopusBeak browser fixture",
    fixtureMarker: "local-browser-ok",
    chromiumVersion: expectedVersion,
    navigatorChromeMajor: expectedVersion.split(".")[0],
    browserClosed: true,
  });

  const visitsBeforeWorkflow = fixture.requestCount;
  workflowFixtureResult = await runPackagedWorkflowFixture(executable, {
    OCTOPUSBEAK_USER_DATA: userDataRoot,
    OCTOPUSBEAK_PACKAGED_RECOGNITION_FIXTURE: process.argv.includes("--recognition") ? "1" : "0",
    TMPDIR: temporaryRoot,
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    OCTOPUSBEAK_PACKAGED_WORKFLOW_FIXTURE: "1",
    OCTOPUSBEAK_PACKAGED_WORKFLOW_FIXTURE_URL: fixture.url,
    OCTOPUSBEAK_PACKAGED_WORKFLOW_FIXTURE_EXPECTED_CHROMIUM_VERSION: expectedVersion,
  });
  assertWorkflowFixtureResult(workflowFixtureResult, expectedVersion);
  if (process.argv.includes("--recognition")) {
    assert.ok(existsSync(join(temporaryRoot, "octopusbeak", "tesseract", "eng.traineddata")),
      "Recognition fixture must download OCR data into its isolated cache.");
  }
  assert.ok(fixture.requestCount - visitsBeforeWorkflow >= 2, "Both packaged App worker cases must load the local fixture.");
} finally {
  fixture.server.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
}
assert.equal(existsSync(temporaryRoot), false, "Packaged App fixture profile and user data must be removed after the run.");
console.log(JSON.stringify({
  status: "passed",
  chromiumVersion: expectedVersion,
  payload: "headless-shell",
  shellExecutableContained: true,
  workerCases: [workflowFixtureResult.success.status, workflowFixtureResult.cancel.status],
  profilesRemoved: true,
  recordsSanitized: true,
  recognition: process.argv.includes("--recognition") ? "passed" : "not-requested",
}));
