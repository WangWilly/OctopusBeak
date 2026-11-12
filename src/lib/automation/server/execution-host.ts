import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  withAppWorkflowHostPage,
  type AppWorkflowBrowserConnection,
  type AppWorkflowBrowserHostInput,
} from "./app-browser-host.ts";
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

/** Starts a round's worker; a throw is a worker start failure. */
export type StartWorker = (launch: WorkerLaunch) => AppWorkflowWorkerHandle;

/** What one round asks its host for: a browser workflow's page; a nonbrowser round asks for none. */
export type ExecutionHostRound = Readonly<{ page?: AppWorkflowBrowserHostInput }>;

/** Where a Workflow execution's page and worker come from (ADR 0129, ADR 0135). */
export type ExecutionHost = Readonly<{
  /**
   * Host one round: open its page when it asks for one, keep it open while
   * `supervise` runs, and hand `supervise` the round's one worker start.
   * Starting a second worker in the same round throws.
   */
  hostRound<T>(round: ExecutionHostRound, supervise: (startWorker: StartWorker) => Promise<T>): Promise<T>;
}>;

/** Wrap a round's worker start so it runs at most once. */
export function oneWorkerPerRound(start: StartWorker): StartWorker {
  let started = false;
  return (launch) => {
    if (started) throw new Error("This round has already started its worker.");
    started = true;
    return start(launch);
  };
}

function workerBundlePath() {
  return typeof __dirname === "string"
    ? join(__dirname, "app-workflow-worker.cjs")
    : join(process.cwd(), "build-electron", "app-workflow-worker.cjs");
}

type ThreadWorkerData = AppWorkflowWorkerStart & {
  browserConnection?: AppWorkflowBrowserConnection;
  pgliteRpc?: PGliteWorkflowRpc;
};

function startThread({ start, pgliteRpc }: WorkerLaunch, browserConnection?: AppWorkflowBrowserConnection) {
  const workerData: ThreadWorkerData = {
    ...start,
    ...(pgliteRpc ? { pgliteRpc } : {}),
    ...(browserConnection ? { browserConnection } : {}),
  };
  const worker = new Worker(workerBundlePath(), { workerData, stdout: true, stderr: true });
  // Captured output is drained and discarded. It is never sent to a log.
  worker.stdout.resume();
  worker.stderr.resume();
  return worker;
}

/**
 * The App's host: a browser round's page is a headless Chromium page the
 * worker thread attaches to through that page's loopback DevTools
 * descriptor, and the thread reaches PGlite through the launch's child RPC
 * descriptor.
 */
export const chromiumThreadHost: ExecutionHost = {
  async hostRound(round, supervise) {
    if (!round.page) return await supervise(oneWorkerPerRound((launch) => startThread(launch)));
    return await withAppWorkflowHostPage(round.page, async ({ connection }) =>
      await supervise(oneWorkerPerRound((launch) => {
        if (!connection) throw new Error("The App browser worker connection is unavailable for this active run.");
        return startThread(launch, connection);
      })));
  },
};
