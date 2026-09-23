import { Worker } from "node:worker_threads";
import { createPGliteViewWorkerClient } from "../../../electron/pglite-view-worker-client.ts";
import type { PGliteOperationalRpcClient } from "../../../electron/pglite-operational-rpc.ts";
import {
  createPGliteWorkflowClient,
  PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND,
  PGLITE_CANONICAL_INVESTMENT_RELATIONS_RESOLVE_COMMAND,
  PGliteWorkflowTransportError,
  type PGliteWorkflowClient,
  type PGliteWorkflowCommand,
  type PGliteWorkflowCommandResult,
  type PGliteWorkflowRequestOptions,
} from "./workflow-client.ts";

export type MaicoinCliPGliteWorkerClient = Readonly<{
  ready: Promise<void>;
  operationalProvider: PGliteOperationalRpcClient["provider"];
  workflow: PGliteWorkflowClient;
  close(): Promise<void>;
}>;

/** Start the existing worker-owned PGlite runtime for standalone CLI runs. */
export function createMaicoinCliPGliteWorkerClient(
  dataDir: string,
): MaicoinCliPGliteWorkerClient {
  if (!dataDir) throw new TypeError("MaiCoin PGlite worker requires a data directory.");

  const viewWorker = createPGliteViewWorkerClient(
    new Worker(new URL("../../../electron/pglite-view-worker.ts", import.meta.url), {
      workerData: { dataDir },
    }),
  );
  const ready = viewWorker
    .subscribe("system.health", {}, () => undefined)
    .then((stop) => stop())
    .then(() => undefined);
  void ready.catch(() => undefined);

  const workflow = createPGliteWorkflowClient({
    execute: async <Command extends PGliteWorkflowCommand>(
      command: Command,
      options?: PGliteWorkflowRequestOptions,
    ): Promise<PGliteWorkflowCommandResult<Command>> => {
      let result: unknown;
      if (command.kind === PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND) {
        result = await viewWorker.financial.registry.investmentCommit(command.request, options);
      } else if (command.kind === PGLITE_CANONICAL_INVESTMENT_RELATIONS_RESOLVE_COMMAND) {
        result = await viewWorker.financial.registry.resolveInvestmentRelations(command.request, options);
      } else {
        throw new PGliteWorkflowTransportError("command-unavailable");
      }
      return result as PGliteWorkflowCommandResult<Command>;
    },
  });

  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    ready,
    operationalProvider: viewWorker.operationalProvider,
    workflow,
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        await ready.catch(() => undefined);
        await viewWorker.close();
      })();
      return closePromise;
    },
  });
}
