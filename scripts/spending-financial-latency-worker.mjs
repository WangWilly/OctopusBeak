import { parentPort } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { createCanonicalSourceStore } from "../src/ledger/canonical/canonical-source-store.ts";
import { executeSpendingRecognitionCommand } from "../src/ledger/canonical/spending-recognition.ts";
import { createFinancialPerformanceTelemetry } from "../src/lib/performance/financial-performance-telemetry.ts";

if (!parentPort) throw new Error("Spending latency benchmark worker requires a parent port.");

let store;
let directory;

function closeStore() {
  try { store?.close(); } catch { /* benchmark cleanup must not mask the result */ }
  store = undefined;
  directory = undefined;
}

function openStore(nextDirectory) {
  if (directory !== nextDirectory || !store) {
    closeStore();
    store = createCanonicalSourceStore(nextDirectory, { commitClock: () => 1_800_000_000_000_000 });
    directory = nextDirectory;
  }
}

function dispatch(message) {
  if (message.kind === "open") {
    openStore(message.directory);
    return { kind: "opened" };
  }
  if (message.kind === "reset") {
    closeStore();
    openStore(message.directory);
    return { kind: "reset" };
  }
  if (message.kind === "close") {
    closeStore();
    return { kind: "closed" };
  }
  if (message.kind !== "execute") throw new Error("Unknown spending latency worker request.");
  openStore(message.directory);
  const telemetry = createFinancialPerformanceTelemetry({
    buildProfile: message.buildProfile,
    hardwareProfile: message.hardwareProfile,
  });
  const events = [];
  const unsubscribe = telemetry.subscribe((event) => events.push(event));
  try {
    const startedAt = performance.now();
    const result = executeSpendingRecognitionCommand(store, message.command, telemetry.startOperation("spending-action"));
    return {
      kind: "executed",
      result,
      workerDurationMs: performance.now() - startedAt,
      spans: events.map(({ span, durationMs, outcome }) => ({ span, durationMs, outcome })),
    };
  } finally {
    unsubscribe();
  }
}

parentPort.on("message", async (message) => {
  try {
    const value = dispatch(message);
    parentPort.postMessage({ id: message.id, ok: true, value });
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

process.once("beforeExit", closeStore);
