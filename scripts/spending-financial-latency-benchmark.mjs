import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitCanonicalEInvoiceCapture, E_INVOICE_CONTRACT_VERSION, E_INVOICE_CURRENCY_AUTHORITY, E_INVOICE_ROUTE } from "../src/ledger/canonical/einvoice.ts";
import { CATHAY_DOMESTIC_DEPOSIT_FIXTURE, commitCathayDomesticDeposit, createCanonicalSourceStore } from "../src/ledger/canonical/canonical-source-store.ts";
import { executeSpendingRecognitionCommand } from "../src/ledger/canonical/spending-recognition.ts";
import { FINANCIAL_INTERACTION_SLO_MS } from "../src/lib/performance/financial-performance-telemetry.ts";

export const REPORT_SCHEMA = "spending-financial-latency-report-v1";
export const CHECKPOINT_SCHEMA = "spending-financial-latency-checkpoint-v1";
export const PROFILE_SCHEMA = "spending-financial-latency-profile-v1";
export const FORMAL_MIN_ITERATIONS = 1_000;
export const SCENARIO_OPERATIONS = Object.freeze(["direct-pair", "candidate-confirmation", "unlink"]);
export const SCENARIO_SCALES = Object.freeze(["1x", "2x"]);
export const SCENARIO_WARM_PATHS = Object.freeze([true, false]);
export const SCENARIO_CONTENTION = Object.freeze([false, true]);

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROFILE_PATH = join(SCRIPT_DIRECTORY, "spending-financial-latency-profile.json");
const DEFAULT_BUDGET_PATH = join(SCRIPT_DIRECTORY, "spending-financial-latency-budget.json");
const DEFAULT_HARDWARE_PROFILE = "unknown";
const DEFAULT_BUILD_PROFILE = "production";
const VALID_MODES = new Set(["smoke", "ci", "formal"]);
const VALID_HARDWARE = new Set(["low", "medium", "high", "unknown"]);
const VALID_BUILD = new Set(["development", "production", "test", "unknown"]);
const VALID_OPERATIONS = new Set(SCENARIO_OPERATIONS);
const VALID_SCALES = new Set(SCENARIO_SCALES);

/**
 * Percentiles use nearest-rank semantics.  Keeping this small pure function
 * in the benchmark contract makes reports reproducible and avoids depending
 * on a statistics package that could change the result between Node versions.
 */
export function percentile(samples, quantile) {
  if (!Array.isArray(samples) || samples.length === 0) return 0;
  if (!Number.isFinite(quantile) || quantile <= 0 || quantile > 1) {
    throw new Error("Percentile quantile must be in (0, 1].");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(quantile * sorted.length)));
  return sorted[rank - 1];
}

export function summarizeSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error("Latency samples must not be empty.");
  }
  if (samples.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Latency samples must contain finite non-negative values.");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const round = (value) => Math.round(value * 1000) / 1000;
  return {
    count: samples.length,
    minMs: round(sorted[0]),
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    p99Ms: round(percentile(sorted, 0.99)),
    maxMs: round(sorted.at(-1)),
    meanMs: round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function requireInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} must be an integer >= ${minimum}.`);
  return value;
}

function requireFiniteNumber(value, label, minimum = 0) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) throw new Error(`${label} must be a finite number >= ${minimum}.`);
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

function assertAllowedKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} field is not allowed: ${key}`);
}

function validateStats(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object.`);
  assertAllowedKeys(value, new Set(["count", "minMs", "p50Ms", "p95Ms", "p99Ms", "maxMs", "meanMs"]), label);
  requireInteger(value.count, `${label}.count`, 1);
  for (const key of ["minMs", "p50Ms", "p95Ms", "p99Ms", "maxMs", "meanMs"]) requireFiniteNumber(value[key], `${label}.${key}`);
  if (value.p50Ms > value.p95Ms || value.p95Ms > value.p99Ms || value.p99Ms > value.maxMs) {
    throw new Error(`${label} percentiles must be monotonic.`);
  }
  if (value.minMs > value.maxMs) throw new Error(`${label} minimum exceeds maximum.`);
  return value;
}

function validateCardinalities(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object.`);
  assertAllowedKeys(value, new Set(["invoices", "transactions", "candidates"]), label);
  for (const key of ["invoices", "transactions", "candidates"]) requireInteger(value[key], `${label}.${key}`, 0);
  return value;
}

function validateScenario(value, index) {
  const label = `report.scenarios[${index}]`;
  if (!isPlainObject(value)) throw new Error(`${label} must be an object.`);
  assertAllowedKeys(value, new Set(["operation", "datasetScale", "warmPath", "contention", "iterations", "sloBudgetMs", "status", "cardinalities", "buildProfile", "hardwareProfile", "overall", "spans"]), label);
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

/** Validate and return a privacy-bounded, machine-readable report. */
export function parseLatencyReport(value) {
  if (!isPlainObject(value)) throw new Error("Latency report must be an object.");
  const allowedRoot = new Set(["schema", "mode", "seed", "profile", "datasets", "scenarios"]);
  for (const key of Object.keys(value)) if (!allowedRoot.has(key)) throw new Error(`Latency report field is not allowed: ${key}`);
  if (value.schema !== REPORT_SCHEMA) throw new Error("Latency report schema is invalid.");
  requireEnum(value.mode, new Set(["smoke", "ci", "formal"]), "report.mode");
  requireString(value.seed, "report.seed");
  if (!isPlainObject(value.profile)) throw new Error("report.profile must be an object.");
  assertAllowedKeys(value.profile, new Set(["profileVersion", "source", "baseCardinalities", "stressMultiplier"]), "report.profile");
  if (value.profile.profileVersion !== PROFILE_SCHEMA) throw new Error("report.profile.profileVersion is invalid.");
  requireString(value.profile.source, "report.profile.source");
  validateCardinalities(value.profile.baseCardinalities, "report.profile.baseCardinalities");
  requireInteger(value.profile.stressMultiplier, "report.profile.stressMultiplier", 1);
  if (!Array.isArray(value.datasets) || value.datasets.length === 0) throw new Error("report.datasets must not be empty.");
  for (const [index, dataset] of value.datasets.entries()) {
    const label = `report.datasets[${index}]`;
    if (!isPlainObject(dataset)) throw new Error(`${label} must be an object.`);
    assertAllowedKeys(dataset, new Set(["scale", "multiplier", "cardinalities", "synthetic"]), label);
    requireEnum(dataset.scale, VALID_SCALES, `${label}.scale`);
    requireInteger(dataset.multiplier, `${label}.multiplier`, 1);
    validateCardinalities(dataset.cardinalities, `${label}.cardinalities`);
    if (dataset.synthetic !== true) throw new Error(`${label}.synthetic must be true.`);
  }
  if (!Array.isArray(value.scenarios) || value.scenarios.length === 0) throw new Error("report.scenarios must not be empty.");
  value.scenarios.forEach(validateScenario);
  if (value.mode === "formal" && value.scenarios.some((scenario) => scenario.iterations < FORMAL_MIN_ITERATIONS)) {
    throw new Error(`Formal report requires at least ${FORMAL_MIN_ITERATIONS} iterations per scenario.`);
  }
  if (value.mode === "formal") assertScenarioSet(value.scenarios, expectedFormalScenarioKeys(), "Formal report");
  return value;
}

export function evaluateRegressionBudget(report, budget) {
  parseLatencyReport(report);
  if (!isPlainObject(budget)) throw new Error("Latency budget must be an object.");
  requireString(budget.budgetVersion, "budget.budgetVersion");
  requireInteger(budget.minIterations, "budget.minIterations", 1);
  const violations = [];
  for (const scenario of report.scenarios) {
    if (scenario.iterations < budget.minIterations) {
      violations.push({ scenario: scenarioKey(scenario), reason: "iterations-below-budget", actual: scenario.iterations, limit: budget.minIterations });
    }
    const profile = scenario.contention ? budget.contention : budget.normal;
    if (!isPlainObject(profile)) throw new Error("Latency budget contention profile is missing.");
    const maxP99Ms = requireFiniteNumber(profile.maxP99Ms, "budget.maxP99Ms");
    const maxMaxMs = requireFiniteNumber(profile.maxMaxMs, "budget.maxMaxMs");
    if (scenario.overall.p99Ms > maxP99Ms) {
      violations.push({ scenario: scenarioKey(scenario), reason: "p99-exceeds-budget", actual: scenario.overall.p99Ms, limit: maxP99Ms });
    }
    if (scenario.overall.maxMs > maxMaxMs) {
      violations.push({ scenario: scenarioKey(scenario), reason: "max-exceeds-budget", actual: scenario.overall.maxMs, limit: maxMaxMs });
    }
  }
  return Object.freeze({ passed: violations.length === 0, violations: Object.freeze(violations) });
}

function scenarioKey(scenario) {
  return `${scenario.operation}/${scenario.datasetScale}/${scenario.warmPath ? "warm" : "cold"}/${scenario.contention ? "contention" : "normal"}`;
}

function selectedScenarioKeys(selection) {
  const keys = [];
  for (const scale of selection.scales) {
    for (const operation of selection.operations) {
      for (const warmPath of selection.warmPaths) {
        for (const contention of selection.contention) {
          keys.push(scenarioKey({ operation, datasetScale: scale, warmPath, contention }));
        }
      }
    }
  }
  return keys;
}

export function expectedFormalScenarioKeys() {
  return Object.freeze(selectedScenarioKeys(scenarioSelection("formal", {})));
}

function assertScenarioSet(scenarios, expectedKeys, label) {
  const actualKeys = scenarios.map(scenarioKey);
  const actualSet = new Set(actualKeys);
  if (actualSet.size !== actualKeys.length) throw new Error(`${label} contains duplicate scenario keys.`);
  const expectedSet = new Set(expectedKeys);
  const missing = expectedKeys.filter((key) => !actualSet.has(key));
  const unexpected = actualKeys.filter((key) => !expectedSet.has(key));
  if (missing.length > 0 || unexpected.length > 0 || actualKeys.length !== expectedKeys.length) {
    const details = [];
    if (missing.length > 0) details.push(`missing ${missing.join(", ")}`);
    if (unexpected.length > 0) details.push(`unexpected ${unexpected.join(", ")}`);
    throw new Error(`${label} must contain the complete expected scenario set (${details.join("; ") || "cardinality mismatch"}).`);
  }
}

function hashId(seed, kind, index) {
  return Buffer.from(createHash("sha256").update(`${seed}/${kind}/${index}`).digest().subarray(0, 16));
}

function uuidFromBuffer(value) {
  const hex = Buffer.from(value).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function hashToken(seed, kind, index) {
  return `sha256:${createHash("sha256").update(`${seed}/${kind}/${index}`).digest("base64url")}`;
}

export function createDeterministicDatasetPlan(profile, mode, scale) {
  if (!isPlainObject(profile) || profile.profileVersion !== PROFILE_SCHEMA) throw new Error("Invalid latency profile.");
  requireEnum(mode, new Set(["smoke", "ci", "formal"]), "mode");
  requireEnum(scale, VALID_SCALES, "scale");
  const modeProfile = profile[mode];
  if (!isPlainObject(modeProfile)) throw new Error(`Latency profile does not define ${mode}.`);
  const base = validateCardinalities(modeProfile.baseCardinalities, `${mode}.baseCardinalities`);
  const multiplier = scale === "2x" ? profile.formal?.stressMultiplier ?? 2 : 1;
  return Object.freeze({
    seed: profile.seed,
    scale,
    multiplier,
    cardinalities: Object.freeze({
      invoices: base.invoices * multiplier,
      transactions: base.transactions * multiplier,
      candidates: base.candidates * multiplier,
    }),
  });
}

function eInvoiceFor(seed, index) {
  const serial = String(index + 1).padStart(8, "0");
  return {
    stableInvoiceKey: `synthetic-invoice-${serial}`,
    sourceRevisionKey: `synthetic-invoice-${serial}-revision-1`,
    revisionNumber: 1,
    revisionKind: "issued",
    sourceIdentifiers: { invoiceNumber: `AB${serial}` },
    seller: { taxId: "12345678", name: "Synthetic Seller" },
    total: { coefficient: String(1000 + (index % 37)), scale: 0, currency: "TWD", currencyAuthority: E_INVOICE_CURRENCY_AUTHORITY },
    occurrence: { value: `2026-01-${String((index % 28) + 1).padStart(2, "0")}`, precision: "date", timeZone: "Asia/Taipei", origin: "source-reported" },
    items: [],
    authority: { routeKey: E_INVOICE_ROUTE, contractVersion: E_INVOICE_CONTRACT_VERSION },
    provenance: { kind: "fixture", reference: `synthetic/spending-latency/invoice/${index}` },
  };
}

async function createSyntheticLedger(plan) {
  const directory = await mkdtemp(join(tmpdir(), "octopusbeak-spending-latency-"));
  const detailCount = plan.cardinalities.transactions;
  const details = Array.from({ length: detailCount }, (_, index) => ({
    sequenceNumber: index + 1,
    txnDateTime: `2026-01-${String((index % 28) + 1).padStart(2, "0")}T${String(index % 24).padStart(2, "0")}:00:00`,
    accountDate: `2026-01-${String((index % 28) + 1).padStart(2, "0")}`,
    description: `Synthetic payment ${index}`,
    expendAmt: 1000 + (index % 37),
    incomeAmt: null,
    balance: 1000000 - index * 1000,
  }));
  const cathayRaw = JSON.stringify({
    success: true,
    returnCode: "0000",
    content: { datas: [{
      queryStatus: "Success",
      accountNumber: "SYNTHETIC-ACCOUNT-001",
      count: detailCount,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      details,
    }] },
  });
  await commitCathayDomesticDeposit(directory, {
    ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
    rawResponse: cathayRaw,
    scope: { startDate: "2026-01-01", endDate: "2026-12-31" },
    observedAt: "2026-09-18T00:00:00+08:00",
  });
  const store = createCanonicalSourceStore(directory, { commitClock: () => 1_800_000_000_000_000 });
  const invoices = Array.from({ length: plan.cardinalities.invoices }, (_, index) => eInvoiceFor(plan.seed, index));
  await commitCanonicalEInvoiceCapture(store, {
    captureId: `synthetic-spending-latency-${plan.scale}`,
    sourceConnectionKey: hashToken(plan.seed, "connection", 0),
    identityEpoch: hashToken(plan.seed, "epoch", 0),
    subjectDigest: hashToken(plan.seed, "subject", 0),
    observedAt: "2026-09-18T00:00:00Z",
    scope: {
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      kind: "bounded-range",
      completeness: "complete-range",
      invoiceCompleteness: "complete",
      itemCompleteness: "complete",
      absenceAuthority: "comparable-complete-range",
    },
    pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: invoices.length, terminal: true, metadata: { synthetic: true, cardinality: invoices.length } }],
    invoices,
  });
  const db = store.db;
  const candidateCommit = db.prepare("SELECT commit_id FROM canonical_commits ORDER BY commit_sequence DESC LIMIT 1").get();
  const invoiceRows = db.prepare("SELECT invoice_id FROM einvoice_invoices ORDER BY rowid").all();
  if (invoiceRows.length !== plan.cardinalities.invoices) throw new Error("Synthetic invoice cardinality was not admitted.");
  const transactionIds = db.prepare("SELECT transaction_id FROM financial_transactions ORDER BY rowid").all().map((row) => uuidFromBuffer(row.transaction_id));
  if (transactionIds.length !== plan.cardinalities.transactions) throw new Error("Synthetic transaction cardinality was not admitted.");
  if (plan.cardinalities.candidates > invoiceRows.length || plan.cardinalities.candidates > transactionIds.length) throw new Error("Synthetic candidate cardinality exceeds pair cardinality.");
  const insertCandidate = db.prepare("INSERT INTO spending_match_candidates(candidate_id, candidate_key, invoice_id, transaction_id, algorithm, algorithm_version, similarity_evidence_json, created_commit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (let index = 0; index < plan.cardinalities.candidates; index += 1) {
    insertCandidate.run(
      hashId(plan.seed, "candidate", index),
      `synthetic-candidate-${String(index).padStart(8, "0")}`,
      Buffer.from(invoiceRows[index].invoice_id),
      Buffer.from(transactionIds[index].replaceAll("-", ""), "hex"),
      "synthetic-exact-amount-date",
      "v1",
      JSON.stringify({ exactAmountAndCurrency: true, calendarDayDistance: 0 }),
      Buffer.from(candidateCommit.commit_id),
    );
  }
  const invoiceIds = invoiceRows.map((row) => uuidFromBuffer(row.invoice_id));
  return {
    directory,
    plan,
    store,
    invoiceIds,
    transactionIds,
    cardinalities: Object.freeze({ ...plan.cardinalities }),
  };
}

function createPatch(result) {
  return Object.freeze({
    kind: result.kind,
    outcome: result.outcome,
    eventId: result.eventId,
    knowledgePoint: result.knowledgePoint,
    invoiceId: result.invoiceId,
    transactionId: result.transactionId,
  });
}

function recordDuration(collection, name, startedAt) {
  const duration = performance.now() - startedAt;
  (collection[name] ??= []).push(duration);
  return duration;
}

function commandFor(operation, invoiceId, transactionId, index) {
  return {
    kind: operation === "unlink" ? "remove-link" : "establish-link",
    invoiceId,
    transactionId,
    idempotencyKey: `synthetic-spending-latency/${operation}/${index}`,
  };
}

function contentionLockScript() {
  return `import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[1]);
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
    setTimeout(() => { try { db.exec("ROLLBACK"); } finally { process.stdout.write("released\\n"); } }, Number(process.env.OCTOPUSBEAK_CONTENTION_DELAY_MS || 3));
  }
});
process.stdout.write("ready\\n");`;
}

async function createContentionController(databasePath, delayMs) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", contentionLockScript(), databasePath], {
    env: { ...process.env, OCTOPUSBEAK_CONTENTION_DELAY_MS: String(delayMs) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  const lines = [];
  const waiters = [];
  const onData = (chunk) => {
    output += chunk.toString();
    let newline;
    while ((newline = output.indexOf("\n")) >= 0) {
      const line = output.slice(0, newline).trim();
      output = output.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
    }
  };
  child.stdout.on("data", onData);
  const nextLine = () => new Promise((resolveLine, rejectLine) => {
    if (lines.length > 0) return resolveLine(lines.shift());
    if (child.exitCode !== null) return rejectLine(new Error(`Contention controller exited with ${child.exitCode}.`));
    waiters.push((line) => resolveLine(line));
  });
  const ready = await nextLine();
  if (ready !== "ready") throw new Error(`Contention controller did not start: ${ready}`);
  return Object.freeze({
    async hold() {
      child.stdin.write("hold\n");
      const line = await nextLine();
      if (line !== "locked") throw new Error(`Contention controller did not lock: ${line}`);
    },
    async release() {
      const line = await nextLine();
      if (line !== "released") throw new Error(`Contention controller did not release: ${line}`);
    },
    close() {
      child.kill();
    },
  });
}

async function measureScenario({ dataset, operation, pairOffset = 0, warmPath, contention, iterations, buildProfile, hardwareProfile, contentionDelayMs }) {
  try { dataset.store?.close(); } catch {}
  let store = createCanonicalSourceStore(dataset.directory, { commitClock: () => 1_800_000_000_000_000 });
  const durations = { overall: [], command: [], patch: [] };
  const contentionController = contention ? await createContentionController(join(dataset.directory, "canonical.sqlite"), contentionDelayMs) : null;
  const seededLinks = operation === "unlink";
  if (seededLinks) {
    for (let index = 0; index < iterations; index += 1) {
      const pairIndex = pairOffset + index;
      executeSpendingRecognitionCommand(store, commandFor("direct-pair", dataset.invoiceIds[pairIndex], dataset.transactionIds[pairIndex], `seed-${pairIndex}`));
    }
  }
  try {
    for (let index = 0; index < iterations; index += 1) {
      if (!warmPath) {
        store.close();
        store = createCanonicalSourceStore(dataset.directory, { commitClock: () => 1_800_000_000_000_000 });
        dataset.store = store;
      }
      if (contention) await contentionController.hold();
      const overallStarted = performance.now();
      const commandStarted = performance.now();
      const pairIndex = pairOffset + index;
      const result = executeSpendingRecognitionCommand(store, commandFor(operation, dataset.invoiceIds[pairIndex], dataset.transactionIds[pairIndex], pairIndex));
      recordDuration(durations, "command", commandStarted);
      const patchStarted = performance.now();
      const patch = createPatch(result);
      if (patch.knowledgePoint !== result.knowledgePoint || patch.eventId !== result.eventId) throw new Error("Synthetic patch application failed.");
      recordDuration(durations, "patch", patchStarted);
      recordDuration(durations, "overall", overallStarted);
      if (contention) await contentionController.release();
    }
  } finally {
    contentionController?.close();
    try { store.close(); } catch {}
    dataset.store = store;
  }
  const overall = summarizeSamples(durations.overall);
  const budget = contention ? FINANCIAL_INTERACTION_SLO_MS.contention : FINANCIAL_INTERACTION_SLO_MS.normal;
  return Object.freeze({
    operation,
    datasetScale: dataset.plan.scale,
    warmPath,
    contention,
    iterations,
    sloBudgetMs: budget,
    status: overall.p99Ms <= budget ? "passed" : "failed",
    cardinalities: dataset.cardinalities,
    buildProfile,
    hardwareProfile,
    overall,
    spans: Object.freeze([
      { name: "canonical-command", stats: summarizeSamples(durations.command) },
      { name: "patch-applied", stats: summarizeSamples(durations.patch) },
    ]),
  });
}

function scenarioSelection(mode, options) {
  const operations = options.operations ?? [...SCENARIO_OPERATIONS];
  const scales = options.scales ?? (mode === "formal" ? [...SCENARIO_SCALES] : ["1x"]);
  const warmPaths = options.warmPaths ?? (mode === "smoke" ? [true] : [...SCENARIO_WARM_PATHS]);
  const contention = options.contention === undefined
    ? (mode === "smoke" ? [false] : [...SCENARIO_CONTENTION])
    : [options.contention];
  return { operations, scales, warmPaths, contention };
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function checkpointSelection(selection, selectedIterations, contentionDelayMs) {
  return {
    iterations: selectedIterations,
    operations: [...selection.operations],
    scales: [...selection.scales],
    warmPaths: [...selection.warmPaths],
    contention: [...selection.contention],
    contentionDelayMs,
  };
}

function checkpointMetadata({ mode, profile, buildProfile, hardwareProfile, selection, selectedIterations, contentionDelayMs }) {
  return {
    schema: CHECKPOINT_SCHEMA,
    mode,
    seed: profile.seed,
    profile: {
      profileVersion: profile.profileVersion,
      source: profile.source,
      fingerprint: fingerprint(profile),
    },
    buildProfile,
    hardwareProfile,
    selection: checkpointSelection(selection, selectedIterations, contentionDelayMs),
    scenarioKeys: selectedScenarioKeys(selection),
  };
}

export function validateBenchmarkCheckpoint(value, expected) {
  if (!isPlainObject(value)) throw new Error("Benchmark checkpoint must be an object.");
  assertAllowedKeys(value, new Set(["schema", "mode", "seed", "profile", "buildProfile", "hardwareProfile", "selection", "scenarioKeys", "scenarios"]), "checkpoint");
  if (value.schema !== CHECKPOINT_SCHEMA) throw new Error("Benchmark checkpoint schema is invalid.");
  requireEnum(value.mode, new Set(["smoke", "ci", "formal"]), "checkpoint.mode");
  requireString(value.seed, "checkpoint.seed");
  if (!isPlainObject(value.profile)) throw new Error("checkpoint.profile must be an object.");
  assertAllowedKeys(value.profile, new Set(["profileVersion", "source", "fingerprint"]), "checkpoint.profile");
  requireString(value.profile.profileVersion, "checkpoint.profile.profileVersion");
  requireString(value.profile.source, "checkpoint.profile.source");
  requireString(value.profile.fingerprint, "checkpoint.profile.fingerprint");
  requireEnum(value.buildProfile, VALID_BUILD, "checkpoint.buildProfile");
  requireEnum(value.hardwareProfile, VALID_HARDWARE, "checkpoint.hardwareProfile");
  if (!isPlainObject(value.selection)) throw new Error("checkpoint.selection must be an object.");
  assertAllowedKeys(value.selection, new Set(["iterations", "operations", "scales", "warmPaths", "contention", "contentionDelayMs"]), "checkpoint.selection");
  requireInteger(value.selection.iterations, "checkpoint.selection.iterations", 1);
  requireInteger(value.selection.contentionDelayMs, "checkpoint.selection.contentionDelayMs", 0);
  if (!Array.isArray(value.selection.operations) || !Array.isArray(value.selection.scales) || !Array.isArray(value.selection.warmPaths) || !Array.isArray(value.selection.contention)) {
    throw new Error("checkpoint.selection arrays are invalid.");
  }
  value.selection.operations.forEach((operation) => requireEnum(operation, VALID_OPERATIONS, "checkpoint.selection.operation"));
  value.selection.scales.forEach((scale) => requireEnum(scale, VALID_SCALES, "checkpoint.selection.scale"));
  value.selection.warmPaths.forEach((warmPath) => requireBoolean(warmPath, "checkpoint.selection.warmPath"));
  value.selection.contention.forEach((isContention) => requireBoolean(isContention, "checkpoint.selection.contention"));
  if (!Array.isArray(value.scenarioKeys) || value.scenarioKeys.length === 0) throw new Error("checkpoint.scenarioKeys must not be empty.");
  value.scenarioKeys.forEach((key) => requireString(key, "checkpoint.scenarioKeys[]"));
  if (!Array.isArray(value.scenarios)) throw new Error("checkpoint.scenarios must be an array.");
  const completedKeys = [];
  value.scenarios.forEach((scenario, index) => {
    validateScenario(scenario, index);
    completedKeys.push(scenarioKey(scenario));
  });
  const expectedKeys = expected?.scenarioKeys ?? value.scenarioKeys;
  if (JSON.stringify(value.scenarioKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error("Benchmark checkpoint selection is incompatible.");
  }
  if (new Set(value.scenarioKeys).size !== value.scenarioKeys.length) throw new Error("checkpoint.scenarioKeys contains duplicates.");
  const allowedKeys = new Set(expectedKeys);
  if (completedKeys.some((key) => !allowedKeys.has(key))) throw new Error("Benchmark checkpoint contains an unselected scenario.");
  if (new Set(completedKeys).size !== completedKeys.length) throw new Error("Benchmark checkpoint contains duplicate completed scenarios.");
  if (value.mode !== expected?.mode || value.seed !== expected?.seed || value.buildProfile !== expected?.buildProfile || value.hardwareProfile !== expected?.hardwareProfile) {
    throw new Error("Benchmark checkpoint run identity is incompatible.");
  }
  if (value.profile.profileVersion !== expected.profile.profileVersion || value.profile.source !== expected.profile.source || value.profile.fingerprint !== expected.profile.fingerprint) {
    throw new Error("Benchmark checkpoint profile is incompatible.");
  }
  if (JSON.stringify(value.selection) !== JSON.stringify(expected.selection)) {
    throw new Error("Benchmark checkpoint selection is incompatible.");
  }
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

async function readCheckpoint(path, expected) {
  let value;
  try {
    value = JSON.parse(await readFile(resolve(path), "utf8"));
  } catch (error) {
    throw new Error(`Unable to read benchmark checkpoint safely: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateBenchmarkCheckpoint(value, expected);
}

function defaultProgress(message) {
  process.stderr.write(`[spending-latency] ${message}\n`);
}

export async function runBenchmark({
  mode = "smoke",
  profile,
  iterations,
  operations,
  scales,
  warmPaths,
  contention,
  buildProfile = DEFAULT_BUILD_PROFILE,
  hardwareProfile = DEFAULT_HARDWARE_PROFILE,
  contentionDelayMs = 3,
  checkpointPath,
  resume = false,
  onProgress = defaultProgress,
} = {}) {
  requireEnum(mode, new Set(["smoke", "ci", "formal"]), "mode");
  if (!isPlainObject(profile) || profile.profileVersion !== PROFILE_SCHEMA) throw new Error("Invalid latency profile.");
  requireEnum(buildProfile, VALID_BUILD, "buildProfile");
  requireEnum(hardwareProfile, VALID_HARDWARE, "hardwareProfile");
  if (typeof onProgress !== "function") throw new Error("onProgress must be a function.");
  if (resume && !checkpointPath) throw new Error("--resume requires a benchmark checkpoint path.");
  const modeProfile = profile[mode];
  if (!isPlainObject(modeProfile)) throw new Error(`Latency profile does not define ${mode}.`);
  const selectedIterations = iterations ?? modeProfile.iterations;
  requireInteger(selectedIterations, "iterations", 1);
  if (mode === "formal" && selectedIterations < FORMAL_MIN_ITERATIONS) {
    throw new Error(`Formal benchmark requires at least ${FORMAL_MIN_ITERATIONS} iterations per scenario.`);
  }
  if (requireInteger(contentionDelayMs, "contentionDelayMs", 0) > 60_000) throw new Error("contentionDelayMs is too large.");
  const selection = scenarioSelection(mode, { operations, scales, warmPaths, contention });
  for (const operation of selection.operations) requireEnum(operation, VALID_OPERATIONS, "operation");
  for (const scale of selection.scales) requireEnum(scale, VALID_SCALES, "scale");
  for (const warmPath of selection.warmPaths) requireBoolean(warmPath, "warmPath");
  for (const isContention of selection.contention) requireBoolean(isContention, "contention");
  const checkpoint = checkpointMetadata({ mode, profile, buildProfile, hardwareProfile, selection, selectedIterations, contentionDelayMs });
  const selectedKeys = checkpoint.scenarioKeys;
  const completed = new Map();
  if (resume) {
    const saved = await readCheckpoint(checkpointPath, checkpoint);
    for (const scenario of saved.scenarios) completed.set(scenarioKey(scenario), scenario);
  } else if (checkpointPath) {
    await writeAtomicJson(checkpointPath, { ...checkpoint, scenarios: [] });
  }
  const totalScenarios = selectedKeys.length;
  onProgress(`${resume ? "resuming" : "starting"} ${mode} benchmark: ${completed.size}/${totalScenarios} scenarios complete`);
  const datasets = [];
  const datasetReports = [];
  try {
    for (const [scaleIndex, scale] of selection.scales.entries()) {
      const plan = createDeterministicDatasetPlan(profile, mode, scale);
      datasetReports.push({ scale, multiplier: plan.multiplier, cardinalities: plan.cardinalities, synthetic: true });
      const scaleHasPendingScenario = selectedKeys
        .filter((key) => key.split("/")[1] === scale)
        .some((key) => !completed.has(key));
      if (!scaleHasPendingScenario) continue;
      onProgress(`preparing ${scale} dataset (${scaleIndex + 1}/${selection.scales.length})`);
      const dataset = await createSyntheticLedger(plan);
      datasets.push(dataset);
      for (const [operationIndex, operation] of selection.operations.entries()) {
        for (const warmPath of selection.warmPaths) {
          for (const isContention of selection.contention) {
            const key = scenarioKey({ operation, datasetScale: scale, warmPath, contention: isContention });
            if (completed.has(key)) {
              onProgress(`skipped completed ${completed.size}/${totalScenarios} ${key}`);
              continue;
            }
            const scenario = await measureScenario({
              dataset,
              operation,
              pairOffset: operationIndex * selectedIterations,
              warmPath,
              contention: isContention,
              iterations: selectedIterations,
              buildProfile,
              hardwareProfile,
              contentionDelayMs,
            });
            completed.set(key, scenario);
            if (checkpointPath) {
              await writeAtomicJson(checkpointPath, { ...checkpoint, scenarios: selectedKeys.filter((scenarioKeyValue) => completed.has(scenarioKeyValue)).map((scenarioKeyValue) => completed.get(scenarioKeyValue)) });
            }
            onProgress(`completed ${completed.size}/${totalScenarios} ${key} (p99 ${scenario.overall.p99Ms}ms)`);
          }
        }
      }
    }
  } finally {
    for (const dataset of datasets) {
      try { dataset.store.close(); } catch {}
      await rm(dataset.directory, { recursive: true, force: true });
    }
  }
  if (completed.size !== totalScenarios) {
    const missing = selectedKeys.filter((key) => !completed.has(key));
    throw new Error(`Benchmark did not complete the selected scenario set: ${missing.join(", ")}`);
  }
  const reports = selectedKeys.map((key) => completed.get(key));
  const report = {
    schema: REPORT_SCHEMA,
    mode,
    seed: profile.seed,
    profile: {
      profileVersion: profile.profileVersion,
      source: profile.source,
      baseCardinalities: profile["formal"].baseCardinalities,
      stressMultiplier: profile.formal.stressMultiplier,
    },
    datasets: datasetReports,
    scenarios: reports,
  };
  return parseLatencyReport(report);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (!arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
    const [key, inline] = arg.slice(2).split("=", 2);
    if (key === "resume") {
      if (inline !== undefined && inline !== "true") throw new Error("--resume does not accept a false value.");
      options.resume = true;
      continue;
    }
    const value = inline ?? argv[++index];
    if (value === undefined) throw new Error(`Missing value for --${key}.`);
    if (key === "mode") options.mode = value;
    else if (key === "profile") options.profilePath = value;
    else if (key === "budget") options.budgetPath = value;
    else if (key === "output") options.outputPath = value;
    else if (key === "checkpoint") options.checkpointPath = value;
    else if (key === "iterations") options.iterations = Number(value);
    else if (key === "contention-delay-ms") options.contentionDelayMs = Number(value);
    else if (key === "hardware") options.hardwareProfile = value;
    else if (key === "build") options.buildProfile = value;
    else if (key === "operations") options.operations = value.split(",");
    else if (key === "scales") options.scales = value.split(",");
    else if (key === "warm-paths") options.warmPaths = value.split(",").map((entry) => entry === "warm");
    else if (key === "contention") options.contention = value === "true";
    else throw new Error(`Unknown option --${key}.`);
  }
  return options;
}

function usage() {
  return `Usage: node scripts/spending-financial-latency-benchmark.mjs [options]

Options:
  --mode smoke|ci|formal       Benchmark matrix (default: smoke)
  --profile PATH               Cardinality profile JSON
  --budget PATH                CI regression budget JSON
  --output PATH                Machine-readable report destination
  --checkpoint PATH            Atomic per-scenario progress checkpoint
  --resume                     Resume from the compatible checkpoint
  --iterations N               Override operations per scenario (formal >= 1000)
  --operations a,b,c           direct-pair,candidate-confirmation,unlink
  --scales 1x,2x               Synthetic dataset scales
  --warm-paths warm,cold       Path labels to run
  --contention true|false      Restrict writer-contention label
  --contention-delay-ms N      Synthetic SQLite writer hold duration
  --hardware low|medium|high|unknown
  --build development|production|test|unknown
`;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const profile = await readJson(resolve(args.profilePath ?? DEFAULT_PROFILE_PATH));
  const outputPath = args.outputPath ? resolve(args.outputPath) : undefined;
  const checkpointPath = args.checkpointPath
    ? resolve(args.checkpointPath)
    : (args.mode === "formal"
      ? `${outputPath ?? resolve("reports/spending-financial-latency-formal.json")}.checkpoint.json`
      : undefined);
  const report = await runBenchmark({ ...args, profile, checkpointPath });
  if (args.mode === "ci") {
    const budget = await readJson(resolve(args.budgetPath ?? DEFAULT_BUDGET_PATH));
    const evaluation = evaluateRegressionBudget(report, budget);
    if (!evaluation.passed) {
      console.error(JSON.stringify({ ...report, budget: evaluation }, null, 2));
      return 1;
    }
  }
  if (args.mode === "formal" && report.scenarios.some((scenario) => scenario.status === "failed")) {
    console.error(JSON.stringify(report, null, 2));
    return 1;
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (args.outputPath) await writeFile(resolve(args.outputPath), serialized, "utf8");
  else process.stdout.write(serialized);
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().then((exitCode) => { if (exitCode) process.exitCode = exitCode; }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
