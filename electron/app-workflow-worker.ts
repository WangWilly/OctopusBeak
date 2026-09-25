import { parentPort, workerData } from "node:worker_threads";
import { runAppWorkflowWorker } from "../src/lib/automation/server/app-workflow-worker-runtime.ts";

// This entry is emitted for App's managed worker_threads supervisor only.
// It is intentionally absent from package scripts and has no standalone CLI.
const port = parentPort;
if (!port) {
  throw new Error("App workflow worker requires a managed parent port.");
}

void runAppWorkflowWorker({ port, workerData })
  .catch(() => undefined)
  .finally(() => port.close());
