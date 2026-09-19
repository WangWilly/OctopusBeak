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
  validateProjectionTransition,
} from "./spending-financial-latency-electron.mjs";
import { FIXTURE_MODE } from "./spending-financial-latency-fixture.mjs";
import { FORMAL_MIN_ITERATIONS, expectedFormalScenarioKeys, summarizeSamples } from "./spending-financial-latency-benchmark.mjs";
import profile from "./spending-financial-latency-profile.json" with { type: "json" };

class FakeCdpPage {
  linkedCount = 0;
  candidateCount = 2;
  recordCount = 4;
  knowledgePoint = 10;
  reloadCount = 0;

  async evaluate(fn, arg) {
    const source = fn.toString();
    if (source.includes("performance.now() - started")) return 7;
    if (source.includes("requestAnimationFrame")) return undefined;
    if (source.includes("linkKnowledgePoints")) {
      return {
        ready: true,
        linkedCount: this.linkedCount,
        candidateCount: this.candidateCount,
        recordCount: this.recordCount,
        linkKnowledgePoints: this.linkedCount > 0 ? [this.knowledgePoint] : [],
        projectionKnowledgePoints: [],
      };
    }
    if (source.includes("performance.now()")) return 0;
    return arg;
  }

  locator(selector) {
    return {
      first: () => ({
        click: async () => {
          if (selector.includes("confirm-candidate")) {
            this.linkedCount += 1;
            this.candidateCount -= 1;
            this.knowledgePoint += 1;
          } else if (selector.includes("revoke-link")) {
            this.linkedCount -= 1;
            this.knowledgePoint += 1;
          } else if (selector.includes("confirm-direct-pair")) {
            this.linkedCount += 1;
            this.knowledgePoint += 1;
          }
        },
        check: async () => {},
      }),
      click: async () => {
        if (selector.includes("confirm-direct-pair")) {
          this.linkedCount += 1;
          this.knowledgePoint += 1;
        }
      },
      check: async () => {},
    };
  }

  async waitForFunction() {
    return undefined;
  }

  async reload() {
    this.reloadCount += 1;
  }
}

function fakeFixture(page) {
  const calls = { scales: [], resets: [], holds: 0, releases: 0 };
  return {
    mode: FIXTURE_MODE,
    databasePath: "/tmp/fake-spending-latency/canonical.sqlite",
    calls,
    async setScale(scale) {
      calls.scales.push(scale);
      const base = profile.smoke.baseCardinalities;
      const multiplier = scale === "2x" ? profile.formal.stressMultiplier : 1;
      return { mode: FIXTURE_MODE, ready: true, scale, cardinalities: Object.fromEntries(Object.entries(base).map(([key, value]) => [key, value * multiplier])) };
    },
    async resetScenario(scale) {
      calls.resets.push(scale);
      page.linkedCount = 0;
      page.candidateCount = 2;
      page.knowledgePoint = 10;
      const base = profile.smoke.baseCardinalities;
      const multiplier = scale === "2x" ? profile.formal.stressMultiplier : 1;
      return { mode: FIXTURE_MODE, ready: true, scale, cardinalities: Object.fromEntries(Object.entries(base).map(([key, value]) => [key, value * multiplier])) };
    },
    async latestKnowledgePoint() {
      return page.knowledgePoint;
    },
    async close() {},
  };
}

function fakeContentionFactory(_path, _delay) {
  return {
    async hold() { fakeContentionFactory.calls.holds += 1; },
    async release() { fakeContentionFactory.calls.releases += 1; },
    close() {},
  };
}
fakeContentionFactory.calls = { holds: 0, releases: 0 };

test("Electron runner measures a renderer-visible paint boundary for all supported actions", async () => {
  const page = new FakeCdpPage();
  const fixture = fakeFixture(page);
  const report = await runElectronBenchmark({
    page,
    fixture,
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
  assert.equal(report.fixtureEvidence.mode, FIXTURE_MODE);
  assert.equal(report.fixtureEvidence.scaleControllersVerified, true);
  assert.equal(report.fixtureEvidence.projectionOracleVerified, true);
  assert.deepEqual(report.scenarios.map((scenario) => scenario.operation), [
    "direct-pair", "candidate-confirmation", "unlink",
  ]);
  assert.ok(report.scenarios.every((scenario) => scenario.visibilityEvidence === "renderer-dom-visible-after-paint"));
  assert.ok(report.scenarios.every((scenario) => scenario.projectionEvidence === "durable-knowledge-point-and-affected-link-state"));
});

test("Electron runner exercises scale, cold reload, and SQLite contention controls", async () => {
  const page = new FakeCdpPage();
  const fixture = fakeFixture(page);
  fakeContentionFactory.calls = { holds: 0, releases: 0 };
  const report = await runElectronBenchmark({
    page,
    fixture,
    mode: "smoke",
    profile,
    iterations: 2,
    operations: ["direct-pair"],
    scales: ["1x", "2x"],
    warmPaths: [false],
    contention: true,
    buildProfile: "test",
    contentionControllerFactory: fakeContentionFactory,
  });
  assert.deepEqual(fixture.calls.scales, ["1x", "2x"]);
  assert.equal(fixture.calls.resets.length, 2);
  assert.equal(page.reloadCount, 6); // one scenario reload plus two cold iterations per scale
  assert.equal(fakeContentionFactory.calls.holds, 4);
  assert.equal(fakeContentionFactory.calls.releases, 4);
  assert.equal(report.fixtureEvidence.coldReloadsVerified, true);
  assert.equal(report.fixtureEvidence.contentionBracketsVerified, true);
});

test("Electron projection oracle rejects spinner, error, and unrelated DOM changes", () => {
  const before = { ready: true, linkedCount: 1, candidateCount: 2, recordCount: 4, linkKnowledgePoints: [10] };
  assert.throws(() => validateProjectionTransition({
    before,
    after: { ready: false, linkedCount: 2, candidateCount: 1, recordCount: 4, linkKnowledgePoints: [11] },
    operation: "direct-pair",
    knowledgeBefore: 10,
    knowledgeAfter: 11,
  }), /ready visible projection/u);
  assert.throws(() => validateProjectionTransition({
    before,
    after: { ready: true, linkedCount: 1, candidateCount: 2, recordCount: 5, linkKnowledgePoints: [11] },
    operation: "direct-pair",
    knowledgeBefore: 10,
    knowledgeAfter: 11,
  }), /link establishment/u);
  assert.throws(() => validateProjectionTransition({
    before,
    after: { ready: true, linkedCount: 1, candidateCount: 2, recordCount: 4, linkKnowledgePoints: [10] },
    operation: "direct-pair",
    knowledgeBefore: 10,
    knowledgeAfter: 10,
  }), /knowledge point/u);
  assert.throws(() => validateProjectionTransition({
    before,
    after: { ready: true, linkedCount: 2, candidateCount: 2, recordCount: 4, linkKnowledgePoints: [10] },
    operation: "direct-pair",
    knowledgeBefore: 10,
    knowledgeAfter: 11,
  }), /wrong knowledge point/u);
  assert.doesNotThrow(() => validateProjectionTransition({
    before,
    after: { ready: true, linkedCount: 1, candidateCount: 2, recordCount: 4, linkKnowledgePoints: [10] },
    operation: "direct-pair",
    knowledgeBefore: 10,
    knowledgeAfter: 10,
    outcome: "replayed",
  }));
});

test("Electron runner fails closed when fixture controls are unavailable", async () => {
  await assert.rejects(
    () => runElectronBenchmark({ page: new FakeCdpPage(), mode: "smoke", profile, iterations: 1, operations: ["direct-pair"], scales: ["1x"], warmPaths: [true], contention: false }),
    /fixture-only control plane/u,
  );
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
    fixtureEvidence: { mode: FIXTURE_MODE, scaleControllersVerified: true, coldReloadsVerified: true, contentionBracketsVerified: true, projectionOracleVerified: true },
    datasets: [{ scale: "1x", multiplier: 1, cardinalities: profile.smoke.baseCardinalities, synthetic: true }],
    scenarios: [{
      operation: "direct-pair", datasetScale: "1x", warmPath: true, contention: false,
      iterations: 3, sloBudgetMs: 200, status: "passed", cardinalities: profile.smoke.baseCardinalities,
      buildProfile: "test", hardwareProfile: "unknown", overall: stats,
      visibilityEvidence: "renderer-dom-visible-after-paint", projectionEvidence: "durable-knowledge-point-and-affected-link-state", spans: [{ name: "renderer-visible-paint", stats }],
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
    fixtureEvidence: { mode: FIXTURE_MODE, scaleControllersVerified: true, coldReloadsVerified: true, contentionBracketsVerified: true, projectionOracleVerified: true },
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
      fixtureEvidence: { mode: FIXTURE_MODE, scaleControllersVerified: true, coldReloadsVerified: true, contentionBracketsVerified: true, projectionOracleVerified: true },
    datasets: [{ scale: "1x", multiplier: 1, cardinalities: profile.formal.baseCardinalities, synthetic: true }],
    scenarios: expectedFormalScenarioKeys().map((key) => {
      const [operation, datasetScale, warm, contention] = key.split("/");
      return {
        operation, datasetScale, warmPath: warm === "warm", contention: contention === "contention",
        iterations: FORMAL_MIN_ITERATIONS - 1, sloBudgetMs: contention === "contention" ? 500 : 200,
        status: "passed", cardinalities: profile.formal.baseCardinalities, buildProfile: "test", hardwareProfile: "unknown",
        overall: stats, visibilityEvidence: "renderer-dom-visible-after-paint", projectionEvidence: "durable-knowledge-point-and-affected-link-state", spans: [{ name: "renderer-visible-paint", stats }],
      };
    }),
  };
  assert.throws(() => parseElectronLatencyReport(invalid), /at least 1000/u);
});

test("Electron checkpoint resume skips completed scenarios safely", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spending-electron-latency-checkpoint-"));
  const checkpointPath = join(directory, "electron.checkpoint.json");
  try {
    const firstPage = new FakeCdpPage();
    const firstFixture = fakeFixture(firstPage);
    const first = await runElectronBenchmark({
      page: firstPage, fixture: firstFixture, mode: "smoke", profile, iterations: 1,
      operations: ["direct-pair"], scales: ["1x"], warmPaths: [true], contention: false,
      buildProfile: "test", checkpointPath,
    });
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    assert.equal(checkpoint.schema, "spending-financial-latency-electron-checkpoint-v1");
    const resumedPage = new FakeCdpPage();
    const resumedFixture = fakeFixture(resumedPage);
    const resumed = await runElectronBenchmark({
      page: resumedPage, fixture: resumedFixture, mode: "smoke", profile, iterations: 1,
      operations: ["direct-pair"], scales: ["1x"], warmPaths: [true], contention: false,
      buildProfile: "test", checkpointPath, resume: true,
    });
    assert.deepEqual(resumed.scenarios, first.scenarios);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
