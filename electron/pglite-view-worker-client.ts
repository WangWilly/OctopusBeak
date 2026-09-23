import type { Worker } from "node:worker_threads";
import {
  createViewPortClient,
  type ViewPortClient,
} from "../src/lib/data-views/server/view-port.ts";
import {
  createPGliteOperationalRpcClient,
  type PGliteOperationalRpcClient,
} from "./pglite-operational-rpc.ts";
import {
  createPGliteFinancialRpcClient,
  type PGliteFinancialRpcClient,
} from "./pglite-financial-registry.ts";

type WorkerPort = Pick<Worker, "on" | "off" | "postMessage" | "terminate">;

export type PGliteViewWorkerClient = Pick<ViewPortClient, "subscribe"> & {
  /** Typed operational commands and queries over the same worker/database. */
  operationalProvider: PGliteOperationalRpcClient["provider"];
  /** Named canonical financial query/command registry over the same worker/database. */
  financial: PGliteFinancialRpcClient;
  onError(listener: (error: Error) => void): () => void;
  close(): Promise<number>;
};

/** Renderer-independent client for the dedicated named-view PGlite worker. */
export function createPGliteViewWorkerClient(worker: WorkerPort): PGliteViewWorkerClient {
  const views = createViewPortClient(worker);
  let closed = false;
  let readySettled = false;
  let stopped = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let detachReady!: () => void;
  let resolveStopped!: () => void;
  let rejectStopped!: (error: Error) => void;
  const stoppedPromise = new Promise<void>((resolve, reject) => {
    resolveStopped = resolve;
    rejectStopped = reject;
  });
  void stoppedPromise.catch(() => undefined);
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const operational = createPGliteOperationalRpcClient(worker, ready);
  const financial = createPGliteFinancialRpcClient(worker, ready);
  const errorListeners = new Set<(error: Error) => void>();
  const notifyErrorListeners = (error: Error): void => {
    for (const listener of errorListeners) {
      try {
        listener(error);
      } catch {
        // An observer must not interrupt worker failure cleanup.
      }
    }
  };
  const attachReadyListener = () => {
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const kind = (message as { kind?: unknown }).kind;
      if (kind === "worker-ready") {
        readySettled = true;
        resolveReady();
      } else if (kind === "worker-start-failed") {
        closed = true;
        readySettled = true;
        stopped = true;
        resolveStopped();
        const messageText = (message as { message?: unknown }).message;
        const failure = new Error(
          typeof messageText === "string"
            ? `PGlite view worker failed to start: ${messageText}`
            : "PGlite view worker failed to start.",
        );
        detachReady();
        rejectReady(failure);
        void views.close();
        operational.close(failure);
        financial.close(failure);
        notifyErrorListeners(failure);
      } else if (kind === "worker-stopped") {
        stopped = true;
        resolveStopped();
        detachReady();
      }
    };
    detachReady = () => worker.off("message", onMessage);
    worker.on("message", onMessage);
  };
  attachReadyListener();
  void ready.catch(() => undefined);

  const fail = (error: unknown): void => {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (!readySettled) {
      readySettled = true;
      detachReady();
      rejectReady(failure);
    }
    if (!stopped) rejectStopped(failure);
    void views.close();
    operational.close(failure);
    financial.close(failure);
    notifyErrorListeners(failure);
  };
  const onError = (error: unknown) => {
    if (!closed) {
      closed = true;
      fail(error);
    }
  };
  const onExit = (code: number) => {
    if (!closed) {
      closed = true;
      fail(new Error(`PGlite view worker exited with code ${code}.`));
    }
  };
  worker.on("error", onError);
  worker.on("exit", onExit);

  let closePromise: Promise<number> | undefined;
  return {
    operationalProvider: operational.provider,
    financial,
    subscribe: async (view, params, onRows, onError) => {
      if (closed) throw new Error("PGlite view worker is closed.");
      await ready;
      return views.subscribe(view, params, onRows, onError);
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      if (!readySettled) {
        readySettled = true;
        rejectReady(new Error("PGlite view worker is closed."));
      }
      closePromise = views.close().then(async () => {
        operational.close(new Error("PGlite view worker is closed."));
        financial.close(new Error("PGlite view worker is closed."));
        try {
          worker.postMessage({ kind: "shutdown" });
          await Promise.race([
            stoppedPromise,
            new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
          ]);
        } catch {
          // A crashed worker is handled by the bounded terminate fallback.
        } finally {
          detachReady();
          worker.off("error", onError);
          worker.off("exit", onExit);
        }
        return worker.terminate();
      });
      return closePromise;
    },
  };
}
