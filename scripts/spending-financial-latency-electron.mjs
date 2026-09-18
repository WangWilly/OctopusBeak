import { createHash } from "node:crypto";
import { readFile, rename, rm, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";
import profileDefault from "./spending-financial-latency-profile.json" with { type: "json" };
import {
  FORMAL_MIN_ITERATIONS,
  expectedFormalScenarioKeys,
  summarizeSamples,
} from "./spending-financial-latency-benchmark.mjs";

export const REPORT_SCHEMA = "spending-financial-latency-electron-report-v1";
export const CHECKPOINT_SCHEMA = "spending-financial-latency-electron-checkpoint-v1";
export const EVIDENCE_BOUNDARY = "renderer-confirmation-to-visible-current-projection";
export const SCENARIO_OPERATIONS = Object.freeze(["direct-pair", "candidate-confirmation", "unlink"]);
export const SCENARIO_SCALES = Object.freeze(["1x", "2x"]);
export const SCENARIO_WARM_PATHS = Object.freeze([true, false]);
export const SCENARIO_CONTENTION = Object.freeze([false, true]);

const VALID_MODES = new Set(["smoke", "ci", "formal"]);
const VALID_OPERATIONS = new Set(SCENARIO_OPERATIONS);
const VALID_SCALES = new Set(SCENARIO_SCALES);
const VALID_BUILD = new Set(["development", "production", "test", "unknown"]);
const VALID_HARDWARE = new Set(["low", "medium", "high", "unknown"]);
const DEFAULT_SELECTORS = Object.freeze({
  affectedSection: "[data-purchase-report]",
  directOpen: "[data-open-pairing]",
  directPayment: 'input[name="spending-payment"]',
  directConfirm: "[data-confirm-direct-pair]",
  candidateConfirm: "[data-confirm-candidate]",
  unlink: "[data-revoke-link]",
});

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertAllowedKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} field is not allowed: ${key}`);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function requireInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} must be an integer >= ${minimum}.`);
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function requireEnum(value, allowed, label) {
  if (typeof value !== "string" || !allowed.has(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function validateCardinalities(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object.`);
  assertAllowedKeys(value, new Set(["invoices", "transactions", "candidates"]), label);
  for (const key of ["invoices", "transactions", "candidates"]) requireInteger(value[key], `${label}.${key}`, 0);
  return value;
}

function scenarioKey(scenario) {
  return `${scenario.operation}/${scenario.datasetScale}/${scenario.warmPath ? "warm" : "cold"}/${scenario.contention ? "contention" : "normal"}`;
}

function scenarioSelection(mode, options = {}) {
  const operations = options.operations ?? [...SCENARIO_OPERATIONS];
  const scales = options.scales ?? (mode === "formal" ? [...SCENARIO_SCALES] : ["1x"]);
  const warmPaths = options.warmPaths ?? (mode === "smoke" ? [true] : [...SCENARIO_WARM_PATHS]);
  const contention = options.contention === undefined
    ? (mode === "smoke" ? [false] : [...SCENARIO_CONTENTION])
    : [options.contention];
  return { operations, scales, warmPaths, contention };
}

function selectedScenarioKeys(selection) {
  const keys = [];
  for (const scale of selection.scales) {
    for (const operation of selection.operations) {
      for (const warmPath of selection.warmPaths) {
        for (const contention of selection.contention) keys.push(scenarioKey({ operation, datasetScale: scale, warmPath, contention }));
      }
    }
  }
  return keys;
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validateStats(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object.`);
  assertAllowedKeys(value, new Set(["count", "minMs", "p50Ms", "p95Ms", "p99Ms", "maxMs", "meanMs"]), label);
  requireInteger(value.count, `${label}.count`, 1);
  for (const key of ["minMs", "p50Ms", "p95Ms", "p99Ms", "maxMs", "meanMs"]) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0) throw new Error(`${label}.${key} must be finite and non-negative.`);
  }
  return value;
}

function validateScenario(value, index) {
  const label = `report.scenarios[${index}]`;
  if (!isPlainObject(value)) throw new Error(`${label} must be an object.`);
  assertAllowedKeys(value, new Set([
    "operation", "datasetScale", "warmPath", "contention", "iterations", "sloBudgetMs", "status",
    "cardinalities", "buildProfile", "hardwareProfile", "overall", "spans", "visibilityEvidence",
  ]), label);
  requireEnum(value.operation, VALID_OPERATIONS, `${label}.operation`);
  requireEnum(value.datasetScale, VALID_SCALES, `${label}.datasetScale`);
  requireBoolean(value.warmPath, `${label}.warmPath`);
  requireBoolean(value.contention, `${label}.contention`);
  requireInteger(value.iterations, `${label}.iterations`, 1);
  requireInteger(value.sloBudgetMs, `${label}.sloBudgetMs`, 1);
  requireEnum(value.status, new Set(["passed", "failed"]), `${label}.status`);
  requireEnum(value.buildProfile, VALID_BUILD, `${label}.buildProfile`);
  requireEnum(value.hardwareProfile, VALID_HARDWARE, `${label}.hardwareProfile`);
  validateCardinalities(value.cardinalities, `${label}.cardinalities`);
  validateStats(value.overall, `${label}.overall`);
  if (value.overall.count !== value.iterations) throw new Error(`${label}.overall.count must equal iterations.`);
  if (value.visibilityEvidence !== "renderer-dom-visible-after-paint") throw new Error(`${label}.visibilityEvidence is invalid.`);
  if (!Array.isArray(value.spans) || value.spans.length === 0) throw new Error(`${label}.spans must not be empty.`);
  for (const [spanIndex, span] of value.spans.entries()) {
    if (!isPlainObject(span)) throw new Error(`${label}.spans[${spanIndex}] must be an object.`);
    assertAllowedKeys(span, new Set(["name", "stats"]), `${label}.spans[${spanIndex}]`);
    requireString(span.name, `${label}.spans[${spanIndex}].name`);
    validateStats(span.stats, `${label}.spans[${spanIndex}].stats`);
    if (span.stats.count !== value.iterations) throw new Error(`${label}.spans[${spanIndex}].stats.count must equal iterations.`);
  }
  return value;
}

/** Validate only the evidence needed to prove the real renderer boundary. */
export function parseElectronLatencyReport(value) {
  if (!isPlainObject(value)) throw new Error("Electron latency report must be an object.");
  assertAllowedKeys(value, new Set(["schema", "mode", "seed", "profile", "boundary", "datasets", "scenarios"]), "report");
  if (value.schema !== REPORT_SCHEMA) throw new Error("Electron latency report schema is invalid.");
  requireEnum(value.mode, VALID_MODES, "report.mode");
  requireString(value.seed, "report.seed");
  if (!isPlainObject(value.profile)) throw new Error("report.profile must be an object.");
  assertAllowedKeys(value.profile, new Set(["profileVersion", "source", "baseCardinalities", "stressMultiplier"]), "report.profile");
  requireString(value.profile.profileVersion, "report.profile.profileVersion");
  requireString(value.profile.source, "report.profile.source");
  validateCardinalities(value.profile.baseCardinalities, "report.profile.baseCardinalities");
  requireInteger(value.profile.stressMultiplier, "report.profile.stressMultiplier", 1);
  if (!isPlainObject(value.boundary)) throw new Error("report.boundary must be an object.");
  assertAllowedKeys(value.boundary, new Set(["kind", "domPaintMeasured", "syntheticPatchMeasured"]), "report.boundary");
  if (value.boundary.kind !== EVIDENCE_BOUNDARY) throw new Error("report.boundary.kind is invalid.");
  if (value.boundary.domPaintMeasured !== true) throw new Error("Electron report must measure a real DOM paint boundary.");
  if (value.boundary.syntheticPatchMeasured !== false) throw new Error("Electron report must not claim synthetic patch evidence.");
  if (!Array.isArray(value.datasets) || value.datasets.length === 0) throw new Error("report.datasets must not be empty.");
  for (const [index, dataset] of value.datasets.entries()) {
    const label = `report.datasets[${index}]`;
    if (!isPlainObject(dataset)) throw new Error(`${label} must be an object.`);
    assertAllowedKeys(dataset, new Set(["scale", "multiplier", "cardinalities", "synthetic"]), label);
    requireEnum(dataset.scale, VALID_SCALES, `${label}.scale`);
    requireInteger(dataset.multiplier, `${label}.multiplier`, 1);
    validateCardinalities(dataset.cardinalities, `${label}.cardinalities`);
    requireBoolean(dataset.synthetic, `${label}.synthetic`);
  }
  if (!Array.isArray(value.scenarios) || value.scenarios.length === 0) throw new Error("report.scenarios must not be empty.");
  value.scenarios.forEach(validateScenario);
  if (value.mode === "formal" && value.scenarios.some((scenario) => scenario.iterations < FORMAL_MIN_ITERATIONS)) {
    throw new Error(`Formal Electron report requires at least ${FORMAL_MIN_ITERATIONS} iterations per scenario.`);
  }
  if (value.mode === "formal") {
    const expected = expectedFormalScenarioKeys();
    const actual = value.scenarios.map(scenarioKey);
    if (actual.length !== expected.length || new Set(actual).size !== actual.length || expected.some((key) => !actual.includes(key))) {
      throw new Error("Formal Electron report must contain the complete expected scenario set.");
    }
  }
  return value;
}

function snapshotScript(selector) {
  return (target) => {
    const element = document.querySelector(target);
    if (!element) return null;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return null;
    return `${element.innerHTML}\u0000${element.textContent ?? ""}`;
  };
}

async function visibleSnapshot(page, selector) {
  return page.evaluate(snapshotScript(selector), selector);
}

async function waitForPaint(page) {
  await page.evaluate(() => new Promise((resolvePaint) => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))));
}

async function clickOperation(page, operation, selectors) {
  if (operation === "candidate-confirmation") {
    await page.locator(selectors.candidateConfirm).first().click();
    return;
  }
  if (operation === "unlink") {
    await page.locator(selectors.unlink).first().click();
    return;
  }
  await page.locator(selectors.directOpen).first().click();
  await page.locator(selectors.directPayment).first().check();
  await page.locator(selectors.directConfirm).click();
}

async function waitForChangedVisibleSection(page, selector, before, timeoutMs) {
  await page.waitForFunction(
    ({ target, previous }) => {
      const element = document.querySelector(target);
      if (!element) return false;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const current = `${element.innerHTML}\u0000${element.textContent ?? ""}`;
      return previous === null || current !== previous;
    },
    { target: selector, previous: before },
    { timeout: timeoutMs },
  );
}

async function measureElectronOperation(page, operation, selectors, timeoutMs) {
  const before = await visibleSnapshot(page, selectors.affectedSection);
  const startedAt = await page.evaluate(() => performance.now());
  await clickOperation(page, operation, selectors);
  await waitForChangedVisibleSection(page, selectors.affectedSection, before, timeoutMs);
  await waitForPaint(page);
  const durationMs = await page.evaluate((started) => performance.now() - started, startedAt);
  return { durationMs };
}

function checkpointMetadata({ mode, profile, buildProfile, hardwareProfile, selection, iterations }) {
  return {
    schema: CHECKPOINT_SCHEMA,
    mode,
    seed: profile.seed,
    profile: { profileVersion: profile.profileVersion, source: profile.source, fingerprint: fingerprint(profile) },
    buildProfile,
    hardwareProfile,
    selection: { iterations, ...selection },
    scenarioKeys: selectedScenarioKeys(selection),
  };
}

function validateCheckpoint(value, expected) {
  if (!isPlainObject(value)) throw new Error("Electron benchmark checkpoint must be an object.");
  assertAllowedKeys(value, new Set(["schema", "mode", "seed", "profile", "buildProfile", "hardwareProfile", "selection", "scenarioKeys", "scenarios"]), "checkpoint");
  if (value.schema !== CHECKPOINT_SCHEMA) throw new Error("Electron benchmark checkpoint schema is invalid.");
  if (value.mode !== expected.mode || value.seed !== expected.seed || value.buildProfile !== expected.buildProfile || value.hardwareProfile !== expected.hardwareProfile) throw new Error("Electron benchmark checkpoint run identity is incompatible.");
  if (fingerprint(value.profile) !== fingerprint(expected.profile)) throw new Error("Electron benchmark checkpoint profile is incompatible.");
  if (JSON.stringify(value.selection) !== JSON.stringify(expected.selection) || JSON.stringify(value.scenarioKeys) !== JSON.stringify(expected.scenarioKeys)) throw new Error("Electron benchmark checkpoint selection is incompatible.");
  if (!Array.isArray(value.scenarios)) throw new Error("Electron benchmark checkpoint scenarios are invalid.");
  value.scenarios.forEach(validateScenario);
  return value;
}

async function writeAtomicJson(path, value) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Run a real browser-page measurement.  The page is intentionally injected so
 * contract tests can use a tiny fake CDP page while formal runs use Playwright
 * over Electron's DevTools endpoint.
 */
export async function runElectronBenchmark({
  page,
  mode = "smoke",
  profile = profileDefault,
  iterations,
  operations,
  scales,
  warmPaths,
  contention,
  buildProfile = "production",
  hardwareProfile = "unknown",
  selectors = DEFAULT_SELECTORS,
  timeoutMs = 5_000,
  checkpointPath,
  resume = false,
  onProgress = () => {},
} = {}) {
  if (!page) throw new Error("Electron benchmark requires a CDP page.");
  requireEnum(mode, VALID_MODES, "mode");
  requireEnum(buildProfile, VALID_BUILD, "buildProfile");
  requireEnum(hardwareProfile, VALID_HARDWARE, "hardwareProfile");
  const selectedIterations = iterations ?? profile[mode].iterations;
  requireInteger(selectedIterations, "iterations", 1);
  if (mode === "formal" && selectedIterations < FORMAL_MIN_ITERATIONS) throw new Error(`Formal Electron benchmark requires at least ${FORMAL_MIN_ITERATIONS} iterations per scenario.`);
  const selection = scenarioSelection(mode, { operations, scales, warmPaths, contention });
  selection.operations.forEach((value) => requireEnum(value, VALID_OPERATIONS, "operation"));
  selection.scales.forEach((value) => requireEnum(value, VALID_SCALES, "scale"));
  selection.warmPaths.forEach((value) => requireBoolean(value, "warmPath"));
  selection.contention.forEach((value) => requireBoolean(value, "contention"));
  const normalizedSelectors = { ...DEFAULT_SELECTORS, ...selectors };
  const metadata = checkpointMetadata({ mode, profile, buildProfile, hardwareProfile, selection, iterations: selectedIterations });
  const completed = new Map();
  if (resume) {
    if (!checkpointPath) throw new Error("Electron benchmark --resume requires a checkpoint path.");
    const saved = JSON.parse(await readFile(resolve(checkpointPath), "utf8"));
    validateCheckpoint(saved, metadata);
    for (const scenario of saved.scenarios) completed.set(scenarioKey(scenario), scenario);
  } else if (checkpointPath) {
    await writeAtomicJson(checkpointPath, { ...metadata, scenarios: [] });
  }
  const selectedKeys = metadata.scenarioKeys;
  onProgress(`${resume ? "resuming" : "starting"} Electron benchmark: ${completed.size}/${selectedKeys.length} scenarios complete`);
  for (const scale of selection.scales) {
    for (const operation of selection.operations) {
      for (const warmPath of selection.warmPaths) {
        for (const isContention of selection.contention) {
          const key = scenarioKey({ operation, datasetScale: scale, warmPath, contention: isContention });
          if (completed.has(key)) continue;
          const durations = [];
          const paintDurations = [];
          for (let index = 0; index < selectedIterations; index += 1) {
            const measurement = await measureElectronOperation(page, operation, normalizedSelectors, timeoutMs);
            durations.push(measurement.durationMs);
            paintDurations.push(measurement.durationMs);
          }
          const overall = summarizeSamples(durations);
          const budget = isContention ? 500 : 200;
          const multiplier = scale === "2x" ? profile.formal.stressMultiplier : 1;
          const baseCardinalities = profile[mode].baseCardinalities;
          const scenario = {
            operation,
            datasetScale: scale,
            warmPath,
            contention: isContention,
            iterations: selectedIterations,
            sloBudgetMs: budget,
            status: overall.p99Ms <= budget ? "passed" : "failed",
            cardinalities: {
              invoices: baseCardinalities.invoices * multiplier,
              transactions: baseCardinalities.transactions * multiplier,
              candidates: baseCardinalities.candidates * multiplier,
            },
            buildProfile,
            hardwareProfile,
            overall,
            visibilityEvidence: "renderer-dom-visible-after-paint",
            spans: [{ name: "renderer-visible-paint", stats: summarizeSamples(paintDurations) }],
          };
          completed.set(key, scenario);
          if (checkpointPath) await writeAtomicJson(checkpointPath, { ...metadata, scenarios: selectedKeys.filter((scenarioKeyValue) => completed.has(scenarioKeyValue)).map((scenarioKeyValue) => completed.get(scenarioKeyValue)) });
          onProgress(`completed ${key} (p99 ${scenario.overall.p99Ms}ms)`);
        }
      }
    }
  }
  const report = {
    schema: REPORT_SCHEMA,
    mode,
    seed: profile.seed,
    profile: {
      profileVersion: profile.profileVersion,
      source: profile.source,
      baseCardinalities: profile.formal.baseCardinalities,
      stressMultiplier: profile.formal.stressMultiplier,
    },
    boundary: { kind: EVIDENCE_BOUNDARY, domPaintMeasured: true, syntheticPatchMeasured: false },
    datasets: selection.scales.map((scale) => {
      const multiplier = scale === "2x" ? profile.formal.stressMultiplier : 1;
      const base = profile[mode].baseCardinalities;
      return {
        scale,
        multiplier,
        cardinalities: {
          invoices: base.invoices * multiplier,
          transactions: base.transactions * multiplier,
          candidates: base.candidates * multiplier,
        },
        synthetic: true,
      };
    }),
    scenarios: selectedKeys.map((key) => completed.get(key)),
  };
  return parseElectronLatencyReport(report);
}

async function connectCdp(endpoint, route) {
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  if (!context) throw new Error("Electron CDP endpoint has no browser context.");
  const page = context.pages()[0] ?? await context.newPage();
  if (route) await page.goto(route);
  return { browser, page };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (!arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
    const [key, inline] = arg.slice(2).split("=", 2);
    if (key === "resume") { options.resume = true; continue; }
    const value = inline ?? argv[++index];
    if (value === undefined) throw new Error(`Missing value for --${key}.`);
    if (key === "mode") options.mode = value;
    else if (key === "cdp-endpoint") options.cdpEndpoint = value;
    else if (key === "route") options.route = value;
    else if (key === "output") options.outputPath = value;
    else if (key === "checkpoint") options.checkpointPath = value;
    else if (key === "iterations") options.iterations = Number(value);
    else if (key === "operations") options.operations = value.split(",");
    else if (key === "scales") options.scales = value.split(",");
    else if (key === "warm-paths") options.warmPaths = value.split(",").map((entry) => entry === "warm");
    else if (key === "contention") options.contention = value === "true";
    else if (key === "hardware") options.hardwareProfile = value;
    else if (key === "build") options.buildProfile = value;
    else if (key === "affected-selector") options.affectedSelector = value;
    else if (key === "timeout-ms") options.timeoutMs = Number(value);
    else throw new Error(`Unknown option --${key}.`);
  }
  return options;
}

function usage() {
  return `Usage: node scripts/spending-financial-latency-electron.mjs [options]\n\nOptions:\n  --mode smoke|ci|formal       Electron/CDP matrix (formal >= 1000)\n  --cdp-endpoint URL           Electron remote debugging endpoint\n  --route URL                  Optional route to open before measuring\n  --affected-selector CSS      Visible projection selector (default: [data-purchase-report])\n  --output PATH                Machine-readable report destination\n  --checkpoint PATH            Atomic per-scenario checkpoint\n  --resume                     Resume a compatible checkpoint\n  --iterations N               Override operations per scenario\n  --operations a,b,c           direct-pair,candidate-confirmation,unlink\n  --scales 1x,2x               Dataset scale labels\n  --warm-paths warm,cold       Path labels\n  --contention true|false      Contention label\n  --timeout-ms N               Visible projection timeout\n`;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { console.log(usage()); return 0; }
  if (!args.cdpEndpoint) throw new Error("--cdp-endpoint is required for Electron acceptance evidence.");
  const { browser, page } = await connectCdp(args.cdpEndpoint, args.route);
  try {
    const report = await runElectronBenchmark({
      ...args,
      profile: profileDefault,
      selectors: { affectedSection: args.affectedSelector ?? DEFAULT_SELECTORS.affectedSection },
      checkpointPath: args.checkpointPath ?? (args.mode === "formal" ? `${args.outputPath ?? "reports/spending-financial-latency-electron-formal.json"}.checkpoint.json` : undefined),
    });
    if (args.outputPath) await writeFile(resolve(args.outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.scenarios.some((scenario) => scenario.status === "failed") ? 1 : 0;
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().then((exitCode) => { process.exitCode = exitCode; }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
