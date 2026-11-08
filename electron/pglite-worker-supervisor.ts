import type { PGliteFinancialRpcClient } from "./pglite-financial-rpc-client.ts";
import { operationalProviderOver } from "./pglite-operational-rpc.ts";
import type { PGliteViewWorkerClient } from "./pglite-view-worker-client.ts";

/** A worker that keeps crashing more often than this gives up instead of looping. */
export const MAX_RESTARTS_PER_WINDOW = 3;
export const RESTART_WINDOW_MS = 60_000;

type LiveSubscription = {
  view: string;
  params: object;
  onValue(value: unknown): void;
  onError?(error: Error): void;
  stop?: () => Promise<void>;
  stopped: boolean;
};

/**
 * The PGlite worker as one client that outlives its worker. When a worker
 * that had opened the database dies, a new one opens the same data directory:
 * requests in flight fail with the worker's error, later requests reach the
 * new worker, and every live view subscribes again with its view and params.
 * A worker that never opened the database is not restarted, and neither is
 * one that crashes a fourth time within a minute; those failures reach
 * `onError` as before.
 */
export function superviseWorker(options: Readonly<{
  spawn: () => PGliteViewWorkerClient;
  now?: () => number;
  onRestart?: (error: Error) => void;
}>): PGliteViewWorkerClient {
  const now = options.now ?? Date.now;
  const errorListeners = new Set<(error: Error) => void>();
  const subscriptions = new Set<LiveSubscription>();
  const crashes: number[] = [];
  let closed = false;
  let failed: Error | undefined;
  let current!: PGliteViewWorkerClient;
  let becameReady = false;
  let detach = () => {};

  const giveUp = (error: Error) => {
    failed = error;
    for (const listener of errorListeners) {
      try {
        listener(error);
      } catch {
        // An observer must not interrupt failure handling.
      }
    }
  };

  const resubscribe = (subscription: LiveSubscription) => {
    current.subscribe(subscription.view, subscription.params, subscription.onValue, subscription.onError)
      .then((stop) => {
        if (subscription.stopped) void stop().catch(() => undefined);
        else subscription.stop = stop;
      }, (error: unknown) => {
        subscriptions.delete(subscription);
        subscription.onError?.(error instanceof Error ? error : new Error(String(error)));
      });
  };

  const start = () => {
    const generation = options.spawn();
    current = generation;
    becameReady = false;
    void generation.ready.then(() => {
      if (current === generation) becameReady = true;
    }, () => undefined);
    detach = generation.onError((error) => {
      if (closed || current !== generation) return;
      detach();
      if (!becameReady) {
        giveUp(error);
        return;
      }
      const at = now();
      while (crashes.length > 0 && at - crashes[0]! >= RESTART_WINDOW_MS) crashes.shift();
      if (crashes.length >= MAX_RESTARTS_PER_WINDOW) {
        giveUp(error);
        return;
      }
      crashes.push(at);
      options.onRestart?.(error);
      start();
      for (const subscription of subscriptions) resubscribe(subscription);
    });
  };
  start();

  const unavailable = () => failed ?? new Error("PGlite view worker is closed.");
  const usable = () => !closed && failed === undefined;

  const financial: PGliteFinancialRpcClient = Object.freeze({
    request: ((operation, args, requestOptions) => (usable()
      ? current.financial.request(operation, args, requestOptions)
      : Promise.reject(unavailable()))) as PGliteFinancialRpcClient["request"],
    close: () => {},
  });

  const operationalRequest: PGliteViewWorkerClient["operationalRequest"] = (operation, args) => (usable()
    ? current.operationalRequest(operation, args)
    : Promise.reject(unavailable()));

  return {
    get ready() {
      return current.ready;
    },
    operationalProvider: operationalProviderOver(operationalRequest),
    operationalRequest,
    financial,
    async subscribe(view, params, onValue, onError) {
      if (!usable()) throw unavailable();
      const subscription: LiveSubscription = { view, params, onValue, ...(onError ? { onError } : {}), stopped: false };
      subscription.stop = await current.subscribe(view, params, onValue, onError);
      subscriptions.add(subscription);
      return async () => {
        if (subscription.stopped) return;
        subscription.stopped = true;
        subscriptions.delete(subscription);
        await subscription.stop?.();
      };
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    close() {
      closed = true;
      detach();
      subscriptions.clear();
      return current.close();
    },
  };
}
