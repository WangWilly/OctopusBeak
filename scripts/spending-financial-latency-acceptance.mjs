import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  expectedFormalScenarioKeys,
  parseLatencyReport,
} from "./spending-financial-latency-benchmark.mjs";
import { parseElectronLatencyReport } from "./spending-financial-latency-electron.mjs";

export const ACCEPTANCE_SCHEMA = "spending-financial-latency-acceptance-v1";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertAllowedKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} field is not allowed: ${key}`);
}

function scenarioKey(scenario) {
  return `${scenario.operation}/${scenario.datasetScale}/${scenario.warmPath ? "warm" : "cold"}/${scenario.contention ? "contention" : "normal"}`;
}

function budgetFor(scenario) {
  return scenario.contention ? 500 : 200;
}

/**
 * Both halves are mandatory.  A command report without a real Electron
 * visible-projection report is intentionally incomplete, never a pass.
 */
export function parseAcceptanceEvidence(value) {
  if (!isPlainObject(value)) throw new Error("Latency acceptance evidence must be an object.");
  assertAllowedKeys(value, new Set(["schema", "mode", "workerReport", "electronReport"]), "acceptance");
  if (value.schema !== ACCEPTANCE_SCHEMA) throw new Error("Latency acceptance evidence schema is invalid.");
  if (value.mode !== "formal") throw new Error("Latency acceptance evidence must be formal.");
  if (!value.workerReport) throw new Error("Latency acceptance evidence is incomplete: worker report is missing.");
  if (!value.electronReport) throw new Error("Latency acceptance evidence is incomplete: Electron visible report is missing.");
  const worker = parseLatencyReport(value.workerReport);
  const electron = parseElectronLatencyReport(value.electronReport);
  if (worker.mode !== "formal" || electron.mode !== "formal") throw new Error("Both latency evidence reports must be formal.");
  if (worker.seed !== electron.seed) throw new Error("Latency evidence reports use different seeds.");
  const expected = expectedFormalScenarioKeys();
  const workerKeys = worker.scenarios.map(scenarioKey);
  const electronKeys = electron.scenarios.map(scenarioKey);
  if (JSON.stringify(workerKeys) !== JSON.stringify(expected) || JSON.stringify(electronKeys) !== JSON.stringify(expected)) {
    throw new Error("Latency acceptance evidence must contain the complete formal scenario matrix in the same order.");
  }
  const scenarios = expected.map((key, index) => {
    const workerScenario = worker.scenarios[index];
    const electronScenario = electron.scenarios[index];
    const budgetMs = budgetFor(electronScenario);
    const workerPass = workerScenario.overall.p99Ms <= budgetMs;
    const electronPass = electronScenario.overall.p99Ms <= budgetMs;
    return {
      key,
      budgetMs,
      workerP99Ms: workerScenario.overall.p99Ms,
      electronVisibleP99Ms: electronScenario.overall.p99Ms,
      workerPass,
      electronVisiblePass: electronPass,
      status: workerPass && electronPass ? "passed" : "failed",
    };
  });
  return Object.freeze({
    schema: ACCEPTANCE_SCHEMA,
    mode: "formal",
    seed: worker.seed,
    workerBoundary: worker.boundary.kind,
    electronBoundary: electron.boundary.kind,
    scenarios: Object.freeze(scenarios),
    status: scenarios.every((scenario) => scenario.status === "passed") ? "passed" : "failed",
  });
}

async function main(argv = process.argv.slice(2)) {
  const args = Object.fromEntries(argv.map((value, index, values) => {
    if (value === "--worker" || value === "--electron" || value === "--output") return [value.slice(2), values[index + 1]];
    return [];
  }).filter(([key]) => key));
  if (!args.worker || !args.electron) throw new Error("Formal acceptance requires --worker and --electron reports.");
  const evidence = parseAcceptanceEvidence({
    schema: ACCEPTANCE_SCHEMA,
    mode: "formal",
    workerReport: JSON.parse(await readFile(resolve(args.worker), "utf8")),
    electronReport: JSON.parse(await readFile(resolve(args.electron), "utf8")),
  });
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (args.output) await writeFile(resolve(args.output), serialized, "utf8");
  else process.stdout.write(serialized);
  return evidence.status === "passed" ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().then((exitCode) => { process.exitCode = exitCode; }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
