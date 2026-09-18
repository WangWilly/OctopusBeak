import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  EVIDENCE_BOUNDARY,
  REPORT_SCHEMA,
  parseElectronLatencyReport,
  runElectronBenchmark,
} from "./spending-financial-latency-electron.mjs";
import { FORMAL_MIN_ITERATIONS, expectedFormalScenarioKeys, summarizeSamples } from "./spending-financial-latency-benchmark.mjs";
import profile from "./spending-financial-latency-profile.json" with { type: "json" };

class FakeCdpPage {
  version = 0;

  async evaluate(fn, arg) {
    const source = fn.toString();
    if (source.includes("performance.now() - started")) return 7;
    if (source.includes("requestAnimationFrame")) return undefined;
    if (source.includes("document.querySelector")) return `snapshot-${this.version}`;
    if (source.includes("performance.now()")) return 0;
    return arg;
  }

  locator() {
    return {
      first: () => ({
        click: async () => { this.version += 1; },
        check: async () => { this.version += 1; },
      }),
      click: async () => { this.version += 1; },
      check: async () => { this.version += 1; },
    };
  }

  async waitForFunction() {
    return undefined;
  }
}

test("Electron runner measures a renderer-visible paint boundary for all supported actions", async () => {
  const report = await runElectronBenchmark({
    page: new FakeCdpPage(),
    mode: "smoke",
    profile,
    iterations: 2,
    operations: ["direct-pair", "candidate-confirmation", "unlink"],
    scales: ["1x"],
    warmPaths: [true],
    contention: false,
    buildProfile: "test",
  });
  assert.equal(report.schema, REPORT_SCHEMA);
  assert.equal(report.boundary.kind, EVIDENCE_BOUNDARY);
  assert.equal(report.boundary.domPaintMeasured, true);
  assert.equal(report.boundary.syntheticPatchMeasured, false);
  assert.deepEqual(report.scenarios.map((scenario) => scenario.operation), [
    "direct-pair", "candidate-confirmation", "unlink",
  ]);
  assert.ok(report.scenarios.every((scenario) => scenario.visibilityEvidence === "renderer-dom-visible-after-paint"));
});

test("Electron parser rejects a report that labels synthetic patch work as visible paint", () => {
  const stats = summarizeSamples([1, 2, 3]);
  const invalid = {
    schema: REPORT_SCHEMA,
    mode: "smoke",
    seed: profile.seed,
    profile: {
      profileVersion: profile.profileVersion,
      source: profile.source,
      baseCardinalities: profile.formal.baseCardinalities,
      stressMultiplier: profile.formal.stressMultiplier,
    },
    boundary: { kind: EVIDENCE_BOUNDARY, domPaintMeasured: false, syntheticPatchMeasured: true },
    datasets: [{ scale: "1x", multiplier: 1, cardinalities: profile.smoke.baseCardinalities, synthetic: true }],
    scenarios: [{
      operation: "direct-pair", datasetScale: "1x", warmPath: true, contention: false,
      iterations: 3, sloBudgetMs: 200, status: "passed", cardinalities: profile.smoke.baseCardinalities,
      buildProfile: "test", hardwareProfile: "unknown", overall: stats,
      visibilityEvidence: "renderer-dom-visible-after-paint", spans: [{ name: "renderer-visible-paint", stats }],
    }],
  };
  assert.throws(() => parseElectronLatencyReport(invalid), /real DOM paint boundary/u);
});

test("Electron report rejects financial identities and payloads", () => {
  const report = {
    schema: REPORT_SCHEMA,
    mode: "smoke",
    seed: profile.seed,
    profile: {
      profileVersion: profile.profileVersion,
      source: profile.source,
      baseCardinalities: profile.formal.baseCardinalities,
      stressMultiplier: profile.formal.stressMultiplier,
    },
    boundary: { kind: EVIDENCE_BOUNDARY, domPaintMeasured: true, syntheticPatchMeasured: false },
    datasets: [{ scale: "1x", multiplier: 1, cardinalities: profile.smoke.baseCardinalities, synthetic: true }],
    scenarios: [],
  };
  report.scenarios.push({ accountId: "must-not-cross-report-seam" });
  assert.throws(() => parseElectronLatencyReport(report), /field is not allowed: accountId/u);
});

test("formal Electron evidence requires 1,000 operations and the complete matrix", () => {
  const stats = summarizeSamples(Array.from({ length: FORMAL_MIN_ITERATIONS - 1 }, () => 1));
  const invalid = {
    schema: REPORT_SCHEMA,
    mode: "formal",
    seed: profile.seed,
    profile: {
      profileVersion: profile.profileVersion,
      source: profile.source,
      baseCardinalities: profile.formal.baseCardinalities,
      stressMultiplier: profile.formal.stressMultiplier,
    },
    boundary: { kind: EVIDENCE_BOUNDARY, domPaintMeasured: true, syntheticPatchMeasured: false },
    datasets: [{ scale: "1x", multiplier: 1, cardinalities: profile.formal.baseCardinalities, synthetic: true }],
    scenarios: expectedFormalScenarioKeys().map((key) => {
      const [operation, datasetScale, warm, contention] = key.split("/");
      return {
        operation, datasetScale, warmPath: warm === "warm", contention: contention === "contention",
        iterations: FORMAL_MIN_ITERATIONS - 1, sloBudgetMs: contention === "contention" ? 500 : 200,
        status: "passed", cardinalities: profile.formal.baseCardinalities, buildProfile: "test", hardwareProfile: "unknown",
        overall: stats, visibilityEvidence: "renderer-dom-visible-after-paint", spans: [{ name: "renderer-visible-paint", stats }],
      };
    }),
  };
  assert.throws(() => parseElectronLatencyReport(invalid), /at least 1000/u);
});

test("Electron checkpoint resume skips completed scenarios safely", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spending-electron-latency-checkpoint-"));
  const checkpointPath = join(directory, "electron.checkpoint.json");
  try {
    const first = await runElectronBenchmark({
      page: new FakeCdpPage(), mode: "smoke", profile, iterations: 1,
      operations: ["direct-pair"], scales: ["1x"], warmPaths: [true], contention: false,
      buildProfile: "test", checkpointPath,
    });
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    assert.equal(checkpoint.schema, "spending-financial-latency-electron-checkpoint-v1");
    const resumed = await runElectronBenchmark({
      page: new FakeCdpPage(), mode: "smoke", profile, iterations: 1,
      operations: ["direct-pair"], scales: ["1x"], warmPaths: [true], contention: false,
      buildProfile: "test", checkpointPath, resume: true,
    });
    assert.deepEqual(resumed.scenarios, first.scenarios);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
