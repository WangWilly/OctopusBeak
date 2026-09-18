import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, rename, rm, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";
import profileDefault from "./spending-financial-latency-profile.json" with { type: "json" };
import {
  FORMAL_MIN_ITERATIONS,
  expectedFormalScenarioKeys,
  summarizeSamples,
} from "./spending-financial-latency-benchmark.mjs";
import { createSpendingLatencyFixtureController, FIXTURE_MODE } from "./spending-financial-latency-fixture.mjs";

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
const VALID_FIXTURE_MODES = new Set([FIXTURE_MODE]);
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
    "cardinalities", "buildProfile", "hardwareProfile", "overall", "spans", "visibilityEvidence", "projectionEvidence",
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
  if (value.projectionEvidence !== "durable-knowledge-point-and-affected-link-state") throw new Error(`${label}.projectionEvidence is invalid.`);
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
  assertAllowedKeys(value, new Set(["schema", "mode", "seed", "profile", "boundary", "fixtureEvidence", "datasets", "scenarios"]), "report");
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
  if (!isPlainObject(value.fixtureEvidence)) throw new Error("Electron report fixture evidence is missing.");
  assertAllowedKeys(value.fixtureEvidence, new Set(["mode", "scaleControllersVerified", "coldReloadsVerified", "contentionBracketsVerified", "projectionOracleVerified"]), "report.fixtureEvidence");
  requireEnum(value.fixtureEvidence.mode, VALID_FIXTURE_MODES, "report.fixtureEvidence.mode");
  for (const key of ["scaleControllersVerified", "coldReloadsVerified", "contentionBracketsVerified", "projectionOracleVerified"]) {
    if (value.fixtureEvidence[key] !== true) throw new Error(`Electron report fixture evidence ${key} is invalid.`);
  }
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

function projectionSnapshotScript(selector) {
  return (target) => {
    const element = document.querySelector(target);
    if (!element) return null;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return null;
    const alert = document.querySelector('[role="alert"]');
    const linkedRecords = [...element.querySelectorAll('[data-purchase-record][data-basis="linked"]')];
    const candidateButtons = [...element.querySelectorAll('[data-confirm-candidate]')];
    const linkKnowledgePoints = [...element.querySelectorAll('[data-source-details]')]
      .map((entry) => entry.textContent?.match(/(?:Knowledge|知識點)\s*:\s*(\d+)/u)?.[1])
      .filter((value) => value !== undefined)
      .map(Number)
      .filter((value) => Number.isSafeInteger(value) && value >= 0);
    const projectionKnowledgePoints = [
      ...element.querySelectorAll('[data-knowledge-point], [data-projection-knowledge-point]'),
    ]
      .map((entry) => entry.getAttribute('data-knowledge-point') ?? entry.getAttribute('data-projection-knowledge-point'))
      .filter((value) => value !== null)
      .map(Number)
      .filter((value) => Number.isSafeInteger(value) && value >= 0);
    return {
      ready: alert === null && !element.querySelector('[aria-busy="true"]'),
      linkedCount: linkedRecords.length,
      candidateCount: candidateButtons.length,
      recordCount: element.querySelectorAll('[data-purchase-record]').length,
      linkKnowledgePoints,
      projectionKnowledgePoints,
    };
  };
}

async function visibleProjectionSnapshot(page, selector) {
  return page.evaluate(projectionSnapshotScript(selector), selector);
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

async function waitForProjectionReady(page, selector, timeoutMs) {
  await page.waitForFunction(
    (target) => {
      const element = document.querySelector(target);
      if (!element) return false;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
      return document.querySelector('[role="alert"]') === null && !element.querySelector('[aria-busy="true"]');
    },
    selector,
    { timeout: timeoutMs },
  );
}

export function validateProjectionTransition({ before, after, operation, knowledgeBefore, knowledgeAfter, outcome = "committed" }) {
  if (!before || !after || before.ready !== true || after.ready !== true) {
    throw new Error("Electron projection oracle requires a ready visible projection.");
  }
  if (!Number.isSafeInteger(knowledgeBefore) || !Number.isSafeInteger(knowledgeAfter)) {
    throw new Error("Electron projection oracle requires durable knowledge points.");
  }
  const currentKnowledge = knowledgeAfter > knowledgeBefore || (outcome === "replayed" && knowledgeAfter === knowledgeBefore);
  if (!currentKnowledge) throw new Error("Electron projection oracle did not observe a committed or replayed knowledge point.");
  const declaredProjectionKnowledge = [
    ...(Array.isArray(after.linkKnowledgePoints) ? after.linkKnowledgePoints : []),
    ...(Array.isArray(after.projectionKnowledgePoints) ? after.projectionKnowledgePoints : []),
  ];
  if (declaredProjectionKnowledge.length > 0 && !declaredProjectionKnowledge.includes(knowledgeAfter)) {
    throw new Error("Electron projection oracle observed a projection at the wrong knowledge point.");
  }
  if (operation === "unlink") {
    if (outcome === "replayed" ? after.linkedCount > before.linkedCount : after.linkedCount >= before.linkedCount) {
      throw new Error("Electron projection oracle did not observe the link removal.");
    }
    return Object.freeze({ outcome, knowledgePoint: knowledgeAfter });
  }
  if (!declaredProjectionKnowledge.includes(knowledgeAfter)) {
    throw new Error("Electron projection oracle did not observe the affected projection at the durable knowledge point.");
  }
  if (outcome === "replayed" ? after.linkedCount < before.linkedCount : after.linkedCount <= before.linkedCount) {
    throw new Error("Electron projection oracle did not observe the link establishment.");
  }
  if (operation === "candidate-confirmation" && (outcome === "replayed" ? after.candidateCount > before.candidateCount : after.candidateCount >= before.candidateCount)) {
    throw new Error("Electron projection oracle did not observe candidate confirmation.");
  }
  return Object.freeze({ outcome, knowledgePoint: knowledgeAfter });
}

async function waitForProjectionTransition(page, selector, before, operation, timeoutMs) {
  await page.waitForFunction(
    ({ target, previous, action }) => {
      const element = document.querySelector(target);
      if (!element) return false;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (document.querySelector('[role="alert"]') !== null || element.querySelector('[aria-busy="true"]')) return false;
      const linkedCount = element.querySelectorAll('[data-purchase-record][data-basis="linked"]').length;
      const candidateCount = element.querySelectorAll('[data-confirm-candidate]').length;
      return action === "unlink"
        ? linkedCount < previous.linkedCount
        : linkedCount > previous.linkedCount && (action !== "candidate-confirmation" || candidateCount < previous.candidateCount);
    },
    { target: selector, previous: before, action: operation },
    { timeout: timeoutMs },
  );
}

async function measureElectronOperation(page, operation, selectors, timeoutMs, fixture) {
  await waitForProjectionReady(page, selectors.affectedSection, timeoutMs);
  const before = await visibleProjectionSnapshot(page, selectors.affectedSection);
  if (!before) throw new Error("Electron benchmark could not observe a visible Spending projection before the action.");
  const knowledgeBefore = await fixture.latestKnowledgePoint();
  const startedAt = await page.evaluate(() => performance.now());
  await clickOperation(page, operation, selectors);
  await waitForProjectionTransition(page, selectors.affectedSection, before, operation, timeoutMs);
  await waitForPaint(page);
  const durationMs = await page.evaluate((started) => performance.now() - started, startedAt);
  const after = await visibleProjectionSnapshot(page, selectors.affectedSection);
  const knowledgeAfter = await fixture.latestKnowledgePoint();
  const oracle = validateProjectionTransition({ before, after, operation, knowledgeBefore, knowledgeAfter });
  return { durationMs, oracle };
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

function contentionLockScript() {
  return `import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[1]);
db.exec("PRAGMA busy_timeout = 30000");
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const command = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (command !== "hold") continue;
    db.exec("BEGIN IMMEDIATE");
    process.stdout.write("locked\\n");
    setTimeout(() => {
      try { db.exec("ROLLBACK"); process.stdout.write("released\\n"); }
      catch (error) { process.stderr.write(String(error)); process.exitCode = 1; }
    }, Number(process.env.OCTOPUSBEAK_CONTENTION_DELAY_MS || 3));
  }
});
process.stdout.write("ready\\n");`;
}

export async function createSqliteContentionController(databasePath, delayMs) {
  if (typeof databasePath !== "string" || databasePath.length === 0) throw new Error("Contention controller database path is required.");
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw new Error("Contention controller delay must be a non-negative integer.");
  const child = spawn(process.execPath, ["--input-type=module", "-e", contentionLockScript(), databasePath], {
    env: { ...process.env, OCTOPUSBEAK_CONTENTION_DELAY_MS: String(delayMs) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  const lines = [];
  const waiters = [];
  let terminalError = null;
  const onData = (chunk) => {
    output += chunk.toString();
    let newline;
    while ((newline = output.indexOf("\n")) >= 0) {
      const line = output.slice(0, newline).trim();
      output = output.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(line);
      else lines.push(line);
    }
  };
  child.stdout.on("data", onData);
  const failWaiters = (error) => {
    terminalError ??= error;
    while (waiters.length > 0) waiters.shift()?.reject(terminalError);
  };
  child.once("error", () => {
    failWaiters(new Error("Contention controller process failed."));
  });
  child.once("exit", () => {
    failWaiters(new Error("Contention controller exited before completing its lock protocol."));
  });
  const nextLine = () => new Promise((resolveLine, rejectLine) => {
    if (lines.length > 0) return resolveLine(lines.shift());
    if (terminalError) return rejectLine(terminalError);
    if (child.exitCode !== null) return rejectLine(new Error("Contention controller exited before completing its lock protocol."));
    waiters.push({ resolve: resolveLine, reject: rejectLine });
  });
  const ready = await nextLine();
  if (ready !== "ready") throw new Error(`Contention controller did not start: ${ready}`);
  let held = false;
  return Object.freeze({
    async hold() {
      if (held) throw new Error("Contention controller lock is already held.");
      child.stdin.write("hold\n");
      const line = await nextLine();
      if (line !== "locked") throw new Error(`Contention controller did not lock: ${line}`);
      held = true;
    },
    async release() {
      if (!held) throw new Error("Contention controller lock is not held.");
      const line = await nextLine();
      if (line !== "released") throw new Error(`Contention controller did not release: ${line}`);
      held = false;
    },
    close() {
      try { child.kill(); } catch {}
    },
  });
}

function assertFixtureController(fixture) {
  if (!fixture || typeof fixture !== "object") throw new Error("Electron benchmark requires a fixture-only control plane.");
  for (const method of ["setScale", "resetScenario", "latestKnowledgePoint"]) {
    if (typeof fixture[method] !== "function") throw new Error(`Electron fixture control plane is missing ${method}.`);
  }
  if (typeof fixture.databasePath !== "string" || fixture.databasePath.length === 0) {
    throw new Error("Electron fixture control plane does not expose a safe database handle.");
  }
}

function assertFixtureControlResult(value, scale, expectedCardinalities, label) {
  if (!isPlainObject(value) || value.mode !== FIXTURE_MODE || value.ready !== true || value.scale !== scale) {
    throw new Error(`${label} did not return a ready fixture marker.`);
  }
  if (!isPlainObject(value.cardinalities)) throw new Error(`${label} cardinalities are missing.`);
  for (const key of ["invoices", "transactions", "candidates"]) {
    if (value.cardinalities[key] !== expectedCardinalities[key]) throw new Error(`${label} cardinality ${key} is invalid.`);
  }
}

/**
 * Run a real browser-page measurement.  The page is intentionally injected so
 * contract tests can use a tiny fake CDP page while formal runs use Playwright
 * over Electron's DevTools endpoint.
 */
export async function runElectronBenchmark({
  page,
  fixture,
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
  contentionDelayMs = 25,
  contentionControllerFactory = createSqliteContentionController,
  onProgress = () => {},
} = {}) {
  if (!page) throw new Error("Electron benchmark requires a CDP page.");
  assertFixtureController(fixture);
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
  const fixtureEvidence = {
    mode: FIXTURE_MODE,
    scaleControllersVerified: false,
    coldReloadsVerified: false,
    contentionBracketsVerified: false,
    projectionOracleVerified: false,
  };
  let scaleControllerCalls = 0;
  let coldReloadCount = 0;
  let contentionLockCount = 0;
  let projectionOracleCount = 0;
  const pendingScales = selection.scales.filter((scale) => selectedKeys
    .filter((key) => key.split("/")[1] === scale)
    .some((key) => !completed.has(key)));
  const pendingColdScenarios = selectedKeys.filter((key) => key.split("/")[2] === "cold" && !completed.has(key)).length;
  const pendingContentionScenarios = selectedKeys.filter((key) => key.endsWith("/contention") && !completed.has(key)).length;
  for (const scale of selection.scales) {
    const scalePending = selectedKeys
      .filter((key) => key.split("/")[1] === scale)
      .some((key) => !completed.has(key));
    if (!scalePending) continue;
    const baseCardinalities = profile[mode].baseCardinalities;
    const multiplier = scale === "2x" ? profile.formal.stressMultiplier : 1;
    const expectedCardinalities = {
      invoices: baseCardinalities.invoices * multiplier,
      transactions: baseCardinalities.transactions * multiplier,
      candidates: baseCardinalities.candidates * multiplier,
    };
    const scaleResult = await fixture.setScale(scale);
    assertFixtureControlResult(scaleResult, scale, expectedCardinalities, `Scale ${scale}`);
    scaleControllerCalls += 1;
    let contentionController;
    try {
      if (selection.contention.includes(true)) {
        contentionController = await contentionControllerFactory(fixture.databasePath, contentionDelayMs);
      }
      for (const operation of selection.operations) {
        for (const warmPath of selection.warmPaths) {
          for (const isContention of selection.contention) {
            const key = scenarioKey({ operation, datasetScale: scale, warmPath, contention: isContention });
            if (completed.has(key)) continue;
            const resetResult = await fixture.resetScenario(scale);
            assertFixtureControlResult(resetResult, scale, expectedCardinalities, `Scenario ${key}`);
            if (typeof page.reload !== "function") throw new Error("Electron benchmark requires page reload support for fixture reset/cold evidence.");
            await page.reload({ waitUntil: "domcontentloaded" });
            await waitForProjectionReady(page, normalizedSelectors.affectedSection, timeoutMs);
            const durations = [];
            const paintDurations = [];
            for (let index = 0; index < selectedIterations; index += 1) {
              if (!warmPath) {
                await page.reload({ waitUntil: "domcontentloaded" });
                coldReloadCount += 1;
                await waitForProjectionReady(page, normalizedSelectors.affectedSection, timeoutMs);
              }
              if (operation === "unlink") {
                const current = await visibleProjectionSnapshot(page, normalizedSelectors.affectedSection);
                if (!current) throw new Error("Electron benchmark could not observe a projection before unlink preparation.");
                if (current.linkedCount === 0) {
                  const beforePreparation = current;
                  const preparationKnowledge = await fixture.latestKnowledgePoint();
                  await clickOperation(page, "direct-pair", normalizedSelectors);
                  await waitForProjectionTransition(page, normalizedSelectors.affectedSection, beforePreparation, "direct-pair", timeoutMs);
                  await waitForPaint(page);
                  const afterPreparation = await visibleProjectionSnapshot(page, normalizedSelectors.affectedSection);
                  const afterKnowledge = await fixture.latestKnowledgePoint();
                  validateProjectionTransition({
                    before: beforePreparation,
                    after: afterPreparation,
                    operation: "direct-pair",
                    knowledgeBefore: preparationKnowledge,
                    knowledgeAfter: afterKnowledge,
                  });
                }
              }
              let held = false;
              if (isContention) {
                await contentionController.hold();
                held = true;
                contentionLockCount += 1;
              }
              let measurement;
              try {
                measurement = await measureElectronOperation(page, operation, normalizedSelectors, timeoutMs, fixture);
              } finally {
                if (held) await contentionController.release();
              }
              durations.push(measurement.durationMs);
              paintDurations.push(measurement.durationMs);
              projectionOracleCount += 1;
            }
            const overall = summarizeSamples(durations);
            const budget = isContention ? 500 : 200;
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
              projectionEvidence: "durable-knowledge-point-and-affected-link-state",
              spans: [{ name: "renderer-visible-paint", stats: summarizeSamples(paintDurations) }],
            };
            completed.set(key, scenario);
            if (checkpointPath) await writeAtomicJson(checkpointPath, { ...metadata, scenarios: selectedKeys.filter((scenarioKeyValue) => completed.has(scenarioKeyValue)).map((scenarioKeyValue) => completed.get(scenarioKeyValue)) });
            onProgress(`completed ${key} (p99 ${scenario.overall.p99Ms}ms)`);
          }
        }
      }
    } finally {
      contentionController?.close();
    }
  }
  fixtureEvidence.scaleControllersVerified = scaleControllerCalls === pendingScales.length;
  fixtureEvidence.coldReloadsVerified = pendingColdScenarios === 0 || coldReloadCount >= pendingColdScenarios;
  fixtureEvidence.contentionBracketsVerified = pendingContentionScenarios === 0 || contentionLockCount >= pendingContentionScenarios;
  fixtureEvidence.projectionOracleVerified = projectionOracleCount > 0 || selectedKeys.every((key) => completed.has(key));
  if (!fixtureEvidence.scaleControllersVerified || !fixtureEvidence.coldReloadsVerified || !fixtureEvidence.contentionBracketsVerified || !fixtureEvidence.projectionOracleVerified) {
    throw new Error("Electron fixture controls did not produce complete acceptance evidence.");
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
    fixtureEvidence,
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
    else if (key === "fixture-user-data") options.fixtureUserData = value;
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
    else if (key === "contention-delay-ms") options.contentionDelayMs = Number(value);
    else throw new Error(`Unknown option --${key}.`);
  }
  return options;
}

function usage() {
  return `Usage: node scripts/spending-financial-latency-electron.mjs [options]\n\nOptions:\n  --mode smoke|ci|formal       Electron/CDP matrix (formal >= 1000)\n  --cdp-endpoint URL           Electron remote debugging endpoint\n  --fixture-user-data PATH     Disposable CDP fixture user-data root (required)\n  --route URL                  Optional route to open before measuring\n  --affected-selector CSS      Visible projection selector (default: [data-purchase-report])\n  --output PATH                Machine-readable report destination\n  --checkpoint PATH            Atomic per-scenario checkpoint\n  --resume                     Resume a compatible checkpoint\n  --iterations N               Override operations per scenario\n  --operations a,b,c           direct-pair,candidate-confirmation,unlink\n  --scales 1x,2x               Dataset scale labels\n  --warm-paths warm,cold       Path labels\n  --contention true|false      Contention label\n  --timeout-ms N               Visible projection timeout\n  --contention-delay-ms N      SQLite writer lock hold duration (default: 25)\n`;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { console.log(usage()); return 0; }
  if (!args.cdpEndpoint) throw new Error("--cdp-endpoint is required for Electron acceptance evidence.");
  if (!args.fixtureUserData) throw new Error("--fixture-user-data is required; Electron acceptance never mutates a normal user store.");
  const { browser, page } = await connectCdp(args.cdpEndpoint, args.route);
  const selectedMode = args.mode ?? "smoke";
  const fixtureBaseCardinalities = profileDefault[selectedMode]?.baseCardinalities ?? profileDefault.formal.baseCardinalities;
  const fixture = await createSpendingLatencyFixtureController({ userData: args.fixtureUserData, seed: profileDefault.seed, baseCardinalities: fixtureBaseCardinalities });
  try {
    const report = await runElectronBenchmark({
      ...args,
      fixture,
      profile: profileDefault,
      selectors: { affectedSection: args.affectedSelector ?? DEFAULT_SELECTORS.affectedSection },
      checkpointPath: args.checkpointPath ?? (args.mode === "formal" ? `${args.outputPath ?? "reports/spending-financial-latency-electron-formal.json"}.checkpoint.json` : undefined),
    });
    if (args.outputPath) await writeFile(resolve(args.outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.scenarios.some((scenario) => scenario.status === "failed") ? 1 : 0;
  } finally {
    await fixture.close();
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().then((exitCode) => { process.exitCode = exitCode; }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
