import assert from "node:assert/strict";
import test from "node:test";
import profile from "./spending-financial-latency-profile.json" with { type: "json" };
import {
  FORMAL_MIN_ITERATIONS,
  createDeterministicDatasetPlan,
  evaluateRegressionBudget,
  parseLatencyReport,
  percentile,
  summarizeSamples,
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
    spans: [
      { name: "canonical-command", stats },
      { name: "patch-applied", stats },
    ],
    ...overrides,
  };
}

function report(scenarios = [scenario()]) {
  return {
    schema: "spending-financial-latency-report-v1",
    mode: "ci",
    seed: profile.seed,
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
