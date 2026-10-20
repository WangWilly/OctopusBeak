import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Browser checks run serially; renderer checks share a lane-owned runtime. */
export const BROWSER_CHECK_FILES = Object.freeze([
  "src/lib/automation/server/app-browser-host.check.ts",
  "src/lib/automation/server/captcha-source-loading.check.ts",
  "src/lib/automation/server/cathay-registration-service.check.ts",
  "src/lib/automation/server/sinopac-login-page.check.ts",
  "src/lib/automation/server/esun-timeline-page.check.ts",
  "src/lib/automation/server/yuanta-report-page.check.ts",
  "src/lib/preview-sources/taishin-login-form.check.ts",
  "scripts/captcha-calibration/collect.check.mjs",
  "scripts/esun-deposit-probe/page.check.mjs",
  "scripts/site-browser.check.mjs",
  "scripts/spending-browser-harness.check.mjs",
  "scripts/spending-page-recovery.check.mjs",
  "scripts/spending-pairing-browser.check.mjs",
  "scripts/spending-review-modals.check.mjs",
  "scripts/spending-empty-state.check.mjs",
  "scripts/accounts-empty-state.check.mjs",
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
  if (options.shard) args.push(`--test-shard=${options.shard.index}/${options.shard.total}`);
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
      env: { ...process.env, ...options.env },
      stdio: "inherit",
    });
    child.once("error", () => resolveResult(1));
    child.once("exit", (code, signal) => resolveResult(code ?? (signal ? 1 : 0)));
  });
}

function readReport(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

const LANES = Object.freeze(["unit", "electron-cdp", "browser", "performance"]);

/** `unit` or `unit-2-of-4`; a shard's reports must not overwrite its siblings'. */
function reportPrefixOf(lane, shard) {
  return shard ? `${lane}-${shard.index}-of-${shard.total}` : lane;
}

/** Merge every per-lane report in `reports/`, whichever job or shard wrote it. */
export function combineCiReports(reports = join(ROOT, "reports")) {
  const prefixes = readdirSync(reports)
    .map((file) => file.match(/^test-summary-(.+)\.txt$/u)?.[1])
    .filter((prefix) => prefix !== undefined)
    .sort((left, right) => {
      const rank = (prefix) => LANES.findIndex((lane) => prefix === lane || prefix.startsWith(`${lane}-`));
      return rank(left) - rank(right) || left.localeCompare(right, "en", { numeric: true });
    });
  const summaries = prefixes.map(
    (prefix) => `# ${prefix} lane\n${readReport(join(reports, `test-summary-${prefix}.txt`))}\n`,
  );
  writeFileSync(join(reports, "test-summary.txt"), summaries.join(""));

  const suites = prefixes.map((prefix) => {
    const xml = readReport(join(reports, `junit-${prefix}.xml`));
    const match = xml.match(/<testsuites(?:\s[^>]*)?>([\s\S]*?)<\/testsuites>/u);
    return match?.[1] ?? "";
  });
  writeFileSync(join(reports, "junit.xml"), `<testsuites>${suites.join("")}</testsuites>\n`);
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
  // Keep heavy browser dependencies out of non-browser lanes. File processes
  // retain Node's isolation while borrowing one renderer server and browser.
  const startedAt = performance.now();
  const runtime = lane === "browser"
    ? await (await import("./browser-test-runtime.mjs")).startBrowserTestRuntime()
    : null;
  try {
    return await runNodeTests(files, {
      ...options,
      env: runtime?.env,
      serial: lane !== "unit",
      forceExit: lane === "electron-cdp",
    });
  } finally {
    await runtime?.close();
    const timing = `Lane ${lane} wall time: ${(performance.now() - startedAt).toFixed(3)} ms (including runtime startup and cleanup)\n`;
    console.log(timing.trimEnd());
    if (options.reportPrefix) {
      appendFileSync(join(ROOT, `reports/test-summary-${options.reportPrefix}.txt`), timing);
    }
  }
}

/** `--shard=2/4` splits the unit lane's files; the serial lanes stay whole. */
export function parseShard(args) {
  const value = args.find((arg) => arg.startsWith("--shard="))?.slice("--shard=".length);
  if (value === undefined) return null;
  const match = value.match(/^(\d+)\/(\d+)$/u);
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || index < 1 || index > total) throw new Error(`Invalid shard: ${value}`);
  return { index, total };
}

async function runLanes(lanes, options = {}) {
  let status = 0;
  for (const lane of lanes) {
    const shard = lane === "unit" ? options.shard : null;
    const reportPrefix = options.reports ? reportPrefixOf(lane, shard) : undefined;
    const laneStatus = await runLane(lane, { coverage: options.reports, reportPrefix, shard });
    status ||= laneStatus;
  }
  return status;
}

async function main() {
  const [command = "all", ...rest] = process.argv.slice(2);
  const lanes = rest.filter((arg) => !arg.startsWith("--"));
  for (const lane of lanes) {
    if (!LANES.includes(lane)) throw new Error(`Unknown test lane: ${lane}`);
  }
  const shard = parseShard(rest);

  if (LANES.includes(command)) process.exitCode = await runLanes([command], { shard });
  else if (command === "all") process.exitCode = await runLanes(LANES);
  else if (command === "ci") {
    // `ci unit --shard=1/4` runs one CI job's slice; bare `ci` runs every lane here.
    mkdirSync(join(ROOT, "reports"), { recursive: true });
    process.exitCode = await runLanes(lanes.length > 0 ? lanes : LANES, { reports: true, shard });
    if (lanes.length === 0) combineCiReports();
  } else if (command === "combine") combineCiReports();
  else throw new Error(`Unknown test command: ${command}`);
}

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
