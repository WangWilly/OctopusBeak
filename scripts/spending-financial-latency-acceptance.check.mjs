import assert from "node:assert/strict";
import test from "node:test";
import { parseAcceptanceEvidence, ACCEPTANCE_SCHEMA } from "./spending-financial-latency-acceptance.mjs";
import { WORKER_REQUIRED_SPANS, REPORT_SCHEMA as WORKER_REPORT_SCHEMA, expectedFormalScenarioKeys, summarizeSamples } from "./spending-financial-latency-benchmark.mjs";
import { EVIDENCE_BOUNDARY, REPORT_SCHEMA as ELECTRON_REPORT_SCHEMA } from "./spending-financial-latency-electron.mjs";
import profile from "./spending-financial-latency-profile.json" with { type: "json" };

function reports() {
  const stats = summarizeSamples(Array.from({ length: 1000 }, () => 1));
  const scenarios = expectedFormalScenarioKeys().map((key) => {
    const [operation, datasetScale, warm, contention] = key.split("/");
    const scenario = {
      operation,
      datasetScale,
      warmPath: warm === "warm",
      contention: contention === "contention",
      iterations: 1000,
      sloBudgetMs: contention === "contention" ? 500 : 200,
      status: "passed",
      cardinalities: profile.formal.baseCardinalities,
      buildProfile: "test",
      hardwareProfile: "unknown",
      overall: stats,
    };
    return scenario;
  });
  return {
    workerReport: {
      schema: WORKER_REPORT_SCHEMA, mode: "formal", seed: profile.seed,
      boundary: { kind: "renderer-to-worker-durable-response", uiVisibleProjectionMeasured: false, syntheticPatchMeasured: false },
      profile: { profileVersion: profile.profileVersion, source: profile.source, baseCardinalities: profile.formal.baseCardinalities, stressMultiplier: profile.formal.stressMultiplier },
      datasets: [{ scale: "1x", multiplier: 1, cardinalities: profile.formal.baseCardinalities, synthetic: true }],
      scenarios: scenarios.map((scenario) => ({ ...scenario, spans: WORKER_REQUIRED_SPANS.map((name) => ({ name, stats })) })),
    },
    electronReport: {
      schema: ELECTRON_REPORT_SCHEMA, mode: "formal", seed: profile.seed,
      boundary: { kind: EVIDENCE_BOUNDARY, domPaintMeasured: true, syntheticPatchMeasured: false },
      profile: { profileVersion: profile.profileVersion, source: profile.source, baseCardinalities: profile.formal.baseCardinalities, stressMultiplier: profile.formal.stressMultiplier },
      datasets: [{ scale: "1x", multiplier: 1, cardinalities: profile.formal.baseCardinalities, synthetic: true }],
      scenarios: scenarios.map((scenario) => ({ ...scenario, visibilityEvidence: "renderer-dom-visible-after-paint", spans: [{ name: "renderer-visible-paint", stats }] })),
    },
  };
}

test("formal acceptance requires both worker and Electron-visible evidence", () => {
  const value = reports();
  const parsed = parseAcceptanceEvidence({ schema: ACCEPTANCE_SCHEMA, mode: "formal", ...value });
  assert.equal(parsed.status, "passed");
  assert.equal(parsed.scenarios.length, 24);
  assert.throws(() => parseAcceptanceEvidence({ schema: ACCEPTANCE_SCHEMA, mode: "formal", workerReport: value.workerReport }), /Electron visible report is missing/u);
  assert.throws(() => parseAcceptanceEvidence({ schema: ACCEPTANCE_SCHEMA, mode: "formal", accountId: "forbidden", ...value }), /field is not allowed: accountId/u);
});
