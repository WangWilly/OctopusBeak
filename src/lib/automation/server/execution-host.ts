import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { WorkflowExecution } from "./active-task-run.ts";
import {
  createAppWorkflowBrowserPort,
  type AppWorkflowBrowserConnection,
  type AppWorkflowBrowserHostInput,
} from "./app-browser-host.ts";
import { appWorkflowRegistration } from "./app-workflow-registry.ts";
import type { AppWorkflowWorkerInboundFrame, AppWorkflowWorkerStart } from "./app-workflow-worker-protocol.ts";
import type { PGliteWorkflowRpc } from "../../pglite-rpc/pglite-child-rpc-client.ts";

/** What the supervisor drives: the frames, liveness and exit of one round's worker. */
export interface AppWorkflowWorkerHandle {
  on(event: "online", listener: () => void): this;
  on(event: "message", listener: (value: unknown) => void): this;
  on(event: "error", listener: (error: unknown) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  off(event: "online", listener: () => void): this;
  off(event: "message", listener: (value: unknown) => void): this;
  off(event: "error", listener: (error: unknown) => void): this;
  off(event: "exit", listener: (code: number) => void): this;
  postMessage(value: AppWorkflowWorkerInboundFrame): void;
  terminate(): Promise<number> | number;
}

/**
 * What a host starts a round's worker with: the core's start frame and, for a
 * definition that declares a capability, the PGlite child RPC that serves it.
 * The descriptor stays in the host and thread adapters (ADR 0134).
 */
export type WorkerLaunch = Readonly<{
  start: AppWorkflowWorkerStart;
  pgliteRpc?: PGliteWorkflowRpc;
}>;

/** Where a Workflow execution's page and worker come from (ADR 0129). */
export type ExecutionHost = Readonly<{
  /** Keep the round's page open while `use` runs; a nonbrowser workflow never asks for one. */
  withPage<T>(run: AppWorkflowBrowserHostInput, use: () => Promise<T>): Promise<T>;
  /** Start the round's worker; a throw is a worker start failure. */
  launchWorker(
    launch: WorkerLaunch,
    execution: Pick<WorkflowExecution, "browserConnection">,
  ): AppWorkflowWorkerHandle;
}>;

function workerBundlePath() {
  return typeof __dirname === "string"
    ? join(__dirname, "app-workflow-worker.cjs")
    : join(process.cwd(), "build-electron", "app-workflow-worker.cjs");
}

/**
 * The App's host: a browser workflow's page is a headless Chromium page the
 * worker thread attaches to through its loopback DevTools descriptor, and the
 * thread reaches PGlite through the launch's child RPC descriptor.
 */
export const chromiumThreadHost: ExecutionHost = {
  async withPage(run, use) {
    return await createAppWorkflowBrowserPort(run).withPage(() => use());
  },
  launchWorker({ start, pgliteRpc }, execution) {
    let workerData: AppWorkflowWorkerStart & {
      browserConnection?: AppWorkflowBrowserConnection;
      pgliteRpc?: PGliteWorkflowRpc;
    } = pgliteRpc ? { ...start, pgliteRpc } : start;
    if (appWorkflowRegistration(start.workflowId)?.runtime.kind !== "nonbrowser") {
      const browserConnection = execution.browserConnection();
      if (!browserConnection) {
        throw new Error("The App browser worker connection is unavailable for this active run.");
      }
      workerData = { ...workerData, browserConnection };
    }
    const worker = new Worker(workerBundlePath(), { workerData, stdout: true, stderr: true });
    // Captured output is drained and discarded. It is never sent to a log.
    worker.stdout.resume();
    worker.stderr.resume();
    return worker;
  },
};
