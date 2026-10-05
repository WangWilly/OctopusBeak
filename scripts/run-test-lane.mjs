import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Browser checks own Chromium/Vite resources and must not share a worker lane. */
export const BROWSER_CHECK_FILES = Object.freeze([
  "src/lib/automation/server/app-browser-host.check.ts",
  "src/lib/automation/server/captcha-source-loading.check.ts",
  "src/lib/automation/server/sinopac-login-page.check.ts",
  "src/lib/automation/server/esun-timeline-page.check.ts",
  "src/lib/automation/server/yuanta-report-page.check.ts",
  "scripts/site-browser.check.mjs",
  "scripts/spending-browser-harness.check.mjs",
  "scripts/spending-page-recovery.check.mjs",
  "scripts/spending-chart-alternatives.check.mjs",
  "scripts/spending-ledger-review.check.mjs",
  "scripts/spending-pairing-browser.check.mjs",
  "scripts/spending-review-modals.check.mjs",
]);

/** These are explicit performance lanes, not ordinary functional tests. */
export const HARD_PERFORMANCE_FILES = Object.freeze([
  "src/ledger/pglite/overview-lifecycle-performance.check.ts",
]);

/** Electron/CDP checks need an isolated process because Electron's macOS
 * NSApplication lifecycle is not safe to run inside the broad test lane. */
export const ELECTRON_CDP_FILES = Object.freeze([
  "electron/automation-runtime-cdp.check.ts",
  "electron/pglite-route-cdp.check.ts",
]);

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function repositoryPath(path) {
  return relative(ROOT, path).split("\\").join("/");
}

function isNodeTestFile(file) {
  if (file.startsWith("src/")) return /\.(?:check|test)\.ts$/u.test(file);
  if (file.startsWith("electron/")) return /\.check\.(?:ts|cjs)$/u.test(file);
  if (file.startsWith("scripts/")) return /\.check\.mjs$/u.test(file);
  return false;
}

/** Discover the same test families previously covered by npm's glob command. */
export function discoverTestFiles() {
  return ["src", "electron", "scripts"]
    .flatMap((directory) => walk(join(ROOT, directory)).map(repositoryPath))
    .filter(isNodeTestFile)
    .sort();
}

export function discoverBrowserTestFiles() {
  for (const file of BROWSER_CHECK_FILES) {
    if (!existsSync(join(ROOT, file))) throw new Error(`Browser test is missing: ${file}`);
  }
  return [...BROWSER_CHECK_FILES].sort();
}

export function discoverUnitTestFiles() {
  const browser = new Set(BROWSER_CHECK_FILES);
  const hardPerformance = new Set(HARD_PERFORMANCE_FILES);
  const electronCdp = new Set(ELECTRON_CDP_FILES);
  return discoverTestFiles().filter(
    (file) => !browser.has(file) && !hardPerformance.has(file) && !electronCdp.has(file),
  );
}

export function discoverElectronCdpTestFiles() {
  for (const file of ELECTRON_CDP_FILES) {
    if (!existsSync(join(ROOT, file))) throw new Error(`Electron/CDP test is missing: ${file}`);
  }
  return [...ELECTRON_CDP_FILES].sort();
}

export function discoverPerformanceTestFiles() {
  for (const file of HARD_PERFORMANCE_FILES) {
    if (!existsSync(join(ROOT, file))) throw new Error(`Performance test is missing: ${file}`);
  }
  return [...HARD_PERFORMANCE_FILES].sort();
}

function runNodeTests(files, options = {}) {
  const args = ["--no-warnings", "--experimental-strip-types"];
  if (options.coverage) args.push("--experimental-test-coverage");
  args.push("--test");
  if (options.forceExit) args.push("--test-force-exit");
  if (options.serial) args.push("--test-concurrency=1");
  if (options.reportPrefix) {
    args.push(
      "--test-reporter=spec",
      `--test-reporter-destination=reports/test-summary-${options.reportPrefix}.txt`,
      "--test-reporter=junit",
      `--test-reporter-destination=reports/junit-${options.reportPrefix}.xml`,
    );
  }
  args.push(...files);
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", () => resolveResult(1));
    child.once("exit", (code, signal) => resolveResult(code ?? (signal ? 1 : 0)));
  });
}

function readReport(path) {
  try {
    return readFileSync(join(ROOT, path), "utf8");
  } catch {
    return "";
  }
}

function combineCiReports() {
  const summaries = [
    "# Unit test lane\n",
    readReport("reports/test-summary-unit.txt"),
    "\n# Serial Electron/CDP lane\n",
    readReport("reports/test-summary-electron-cdp.txt"),
    "\n# Serial browser lane\n",
    readReport("reports/test-summary-browser.txt"),
    "\n# Serial performance lane\n",
    readReport("reports/test-summary-performance.txt"),
  ];
  writeFileSync(join(ROOT, "reports/test-summary.txt"), summaries.join(""));

  const suites = ["unit", "electron-cdp", "browser", "performance"].map((lane) => {
    const xml = readReport(`reports/junit-${lane}.xml`);
    const match = xml.match(/<testsuites(?:\s[^>]*)?>([\s\S]*?)<\/testsuites>/u);
    return match?.[1] ?? "";
  });
  writeFileSync(join(ROOT, "reports/junit.xml"), `<testsuites>${suites.join("")}</testsuites>\n`);
}

async function runLane(lane, options = {}) {
  const files =
    lane === "browser"
      ? discoverBrowserTestFiles()
      : lane === "electron-cdp"
        ? discoverElectronCdpTestFiles()
        : lane === "performance"
          ? discoverPerformanceTestFiles()
          : discoverUnitTestFiles();
  return runNodeTests(files, {
    ...options,
    serial: lane === "browser" || lane === "electron-cdp" || lane === "performance",
    forceExit: lane === "electron-cdp",
  });
}

async function main() {
  const lane = process.argv[2] ?? "all";
  if (!["all", "unit", "electron-cdp", "browser", "performance", "ci"].includes(lane)) {
    throw new Error(`Unknown test lane: ${lane}`);
  }

  if (lane === "unit") process.exitCode = await runLane("unit");
  else if (lane === "electron-cdp") process.exitCode = await runLane("electron-cdp");
  else if (lane === "browser") process.exitCode = await runLane("browser");
  else if (lane === "performance") process.exitCode = await runLane("performance");
  else if (lane === "all") {
    const unitStatus = await runLane("unit");
    const electronCdpStatus = await runLane("electron-cdp");
    const browserStatus = await runLane("browser");
    const performanceStatus = await runLane("performance");
    process.exitCode = unitStatus || electronCdpStatus || browserStatus || performanceStatus;
  } else {
    mkdirSync(join(ROOT, "reports"), { recursive: true });
    const unitStatus = await runLane("unit", { coverage: true, reportPrefix: "unit" });
    const electronCdpStatus = await runLane("electron-cdp", {
      coverage: true,
      reportPrefix: "electron-cdp",
    });
    const browserStatus = await runLane("browser", { coverage: true, reportPrefix: "browser" });
    const performanceStatus = await runLane("performance", {
      coverage: true,
      reportPrefix: "performance",
    });
    combineCiReports();
    process.exitCode = unitStatus || electronCdpStatus || browserStatus || performanceStatus;
  }
}

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
