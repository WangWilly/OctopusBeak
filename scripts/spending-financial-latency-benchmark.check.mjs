import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import profile from "./spending-financial-latency-profile.json" with { type: "json" };
import {
  FORMAL_MIN_ITERATIONS,
  createDeterministicDatasetPlan,
  evaluateRegressionBudget,
  runBenchmark,
  parseLatencyReport,
  percentile,
  summarizeSamples,
  WORKER_REQUIRED_SPANS,
} from "./spending-financial-latency-benchmark.mjs";

function scenario(overrides = {}) {
  const stats = summarizeSamples([1, 2, 3, 4, 5]);
  return {
    operation: "direct-pair",
    datasetScale: "1x",
    warmPath: true,
    contention: false,
    iterations: 5,
    sloBudgetMs: 200,
    status: "passed",
    cardinalities: { invoices: 32, transactions: 32, candidates: 32 },
    buildProfile: "test",
    hardwareProfile: "unknown",
    overall: stats,
    spans: WORKER_REQUIRED_SPANS.map((name) => ({ name, stats })),
    ...overrides,
  };
}

function report(scenarios = [scenario()]) {
  return {
    schema: "spending-financial-latency-worker-report-v1",
    mode: "ci",
    seed: profile.seed,
    boundary: {
      kind: "renderer-to-worker-durable-response",
      uiVisibleProjectionMeasured: false,
      syntheticPatchMeasured: false,
    },
    profile: {
      profileVersion: profile.profileVersion,
      source: profile.source,
      baseCardinalities: profile.formal.baseCardinalities,
      stressMultiplier: profile.formal.stressMultiplier,
    },
    datasets: [{
      scale: "1x",
      multiplier: 1,
      cardinalities: { invoices: 32, transactions: 32, candidates: 32 },
      synthetic: true,
    }],
    scenarios,
  };
}

test("percentiles use deterministic nearest-rank statistics", () => {
  assert.equal(percentile([50, 10, 30, 20, 40], 0.5), 30);
  assert.deepEqual(summarizeSamples([50, 10, 30, 20, 40]), {
    count: 5,
    minMs: 10,
    p50Ms: 30,
    p95Ms: 50,
    p99Ms: 50,
    maxMs: 50,
    meanMs: 30,
  });
});

test("deterministic profile produces 1x and 2x synthetic cardinalities", () => {
  const one = createDeterministicDatasetPlan(profile, "formal", "1x");
  const two = createDeterministicDatasetPlan(profile, "formal", "2x");
  assert.deepEqual(one.cardinalities, profile.formal.baseCardinalities);
  assert.deepEqual(two.cardinalities, {
    invoices: profile.formal.baseCardinalities.invoices * 2,
    transactions: profile.formal.baseCardinalities.transactions * 2,
    candidates: profile.formal.baseCardinalities.candidates * 2,
  });
  assert.deepEqual(createDeterministicDatasetPlan(profile, "formal", "1x"), one);
});

test("report contract carries warm/cold and normal/contention labels", () => {
  const parsed = parseLatencyReport(report([
    scenario(),
    scenario({ operation: "candidate-confirmation", warmPath: false }),
    scenario({ operation: "unlink", contention: true, sloBudgetMs: 500 }),
  ]));
  assert.deepEqual(parsed.scenarios.map((entry) => [entry.operation, entry.warmPath, entry.contention]), [
    ["direct-pair", true, false],
    ["candidate-confirmation", false, false],
    ["unlink", true, true],
  ]);
});

test("worker evidence rejects UI-paint or synthetic-patch claims", () => {
  const invalidUi = report();
  invalidUi.boundary.uiVisibleProjectionMeasured = true;
  assert.throws(() => parseLatencyReport(invalidUi), /must not claim UI-visible projection/u);
  const invalidPatch = report();
  invalidPatch.boundary.syntheticPatchMeasured = true;
  assert.throws(() => parseLatencyReport(invalidPatch), /must not claim synthetic patch/u);
  const missingSpan = report();
  missingSpan.scenarios[0].spans = missingSpan.scenarios[0].spans.filter((span) => span.name !== "worker-response");
  assert.throws(() => parseLatencyReport(missingSpan), /missing required spans: worker-response/u);
});

test("formal report rejects fewer than the required timed operations", () => {
  const formal = report([scenario({ iterations: FORMAL_MIN_ITERATIONS - 1 })]);
  formal.mode = "formal";
  formal.scenarios[0].overall = summarizeSamples(Array.from({ length: FORMAL_MIN_ITERATIONS - 1 }, () => 1));
  formal.scenarios[0].spans = formal.scenarios[0].spans.map((span) => ({ ...span, stats: formal.scenarios[0].overall }));
  assert.throws(() => parseLatencyReport(formal), /at least 1000 iterations/u);
});

test("privacy-bounded report rejects identity and payload fields", () => {
  const unsafe = report();
  unsafe.scenarios[0].invoiceId = "synthetic-only-but-not-a-report-field";
  assert.throws(() => parseLatencyReport(unsafe), /field is not allowed: invoiceId/u);
  const unsafeDataset = report();
  unsafeDataset.datasets[0].payload = "must not cross report seam";
  assert.throws(() => parseLatencyReport(unsafeDataset), /field is not allowed: payload/u);
});

test("CI regression budget reports threshold failures", () => {
  const passing = evaluateRegressionBudget(report(), {
    budgetVersion: "spending-financial-latency-budget-v1",
    minIterations: 5,
    normal: { maxP99Ms: 10, maxMaxMs: 20 },
    contention: { maxP99Ms: 20, maxMaxMs: 40 },
  });
  assert.equal(passing.passed, true);

  const failing = evaluateRegressionBudget(report([scenario({ overall: { ...summarizeSamples([1, 2, 3, 4, 50]), count: 5 } })]), {
    budgetVersion: "spending-financial-latency-budget-v1",
    minIterations: 10,
    normal: { maxP99Ms: 10, maxMaxMs: 20 },
    contention: { maxP99Ms: 20, maxMaxMs: 40 },
  });
  assert.equal(failing.passed, false);
  assert.deepEqual(failing.violations.map((entry) => entry.reason), ["iterations-below-budget", "p99-exceeds-budget", "max-exceeds-budget"]);
});

async function runCheckpointFixture(checkpointPath, overrides = {}) {
  return runBenchmark({
    mode: "smoke",
    profile,
    iterations: 1,
    operations: ["direct-pair"],
    scales: ["1x"],
    warmPaths: [true],
    contention: false,
    checkpointPath,
    onProgress: () => {},
    ...overrides,
  });
}

test("checkpoint is atomically written after a completed scenario and resume skips it", async () => {
  const directory = await mkdtemp(join("/tmp", "spending-latency-checkpoint-"));
  const checkpointPath = join(directory, "benchmark.checkpoint.json");
  const progress = [];
  try {
    const first = await runCheckpointFixture(checkpointPath, { onProgress: (message) => progress.push(message) });
    assert.equal(first.scenarios.length, 1);
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    assert.equal(checkpoint.schema, "spending-financial-latency-checkpoint-v1");
    assert.equal(checkpoint.scenarios.length, 1);
    assert.equal(checkpoint.scenarioKeys.length, 1);
    assert.equal(progress.some((message) => message.includes("completed 1/1 direct-pair/1x/warm/normal")), true);

    const resumedProgress = [];
    const resumed = await runCheckpointFixture(checkpointPath, { resume: true, onProgress: (message) => resumedProgress.push(message) });
    assert.deepEqual(resumed.scenarios, first.scenarios);
    assert.equal(resumedProgress[0], "resuming smoke benchmark: 1/1 scenarios complete");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("resume rejects incompatible selection and corrupt checkpoints safely", async () => {
  const directory = await mkdtemp(join("/tmp", "spending-latency-checkpoint-"));
  const checkpointPath = join(directory, "benchmark.checkpoint.json");
  try {
    await runCheckpointFixture(checkpointPath);
    await assert.rejects(
      runCheckpointFixture(checkpointPath, { resume: true, iterations: 2 }),
      /checkpoint selection is incompatible/u,
    );
    await writeFile(checkpointPath, "{", "utf8");
    await assert.rejects(
      runCheckpointFixture(checkpointPath, { resume: true }),
      /Unable to read benchmark checkpoint safely/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("formal reports reject a partial scenario matrix even when iteration minimum is met", () => {
  const completeIterationStats = summarizeSamples(Array.from({ length: FORMAL_MIN_ITERATIONS }, () => 1));
  const partial = report([scenario({
    iterations: FORMAL_MIN_ITERATIONS,
    overall: completeIterationStats,
    spans: WORKER_REQUIRED_SPANS.map((name) => ({ name, stats: completeIterationStats })),
  })]);
  partial.mode = "formal";
  assert.throws(() => parseLatencyReport(partial), /complete expected scenario set/u);
});
