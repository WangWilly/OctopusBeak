import { PGliteFinancialError, type PGliteFinancialRpcClient } from "../src/lib/pglite-rpc/pglite-financial-rpc-client.ts";
import { operationalProviderOver, PGliteOperationalError } from "../src/lib/pglite-rpc/pglite-operational-rpc.ts";
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
  /** The worker this subscription was last sent to; each worker receives it once. */
  attachedTo?: PGliteViewWorkerClient;
  stopped: boolean;
};

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

/**
 * The PGlite worker as one client that outlives its worker. When a worker
 * that had opened the database dies, it is closed (its thread terminated and
 * exited) before a new one opens the same data directory, so two PGlite
 * instances never share it. Requests in flight fail with the worker's error;
 * requests sent during and after the restart reach the new worker; every live
 * view subscribes again with its view and params. A worker that never opened
 * the database is not restarted, and neither is one that crashes a fourth
 * time within a minute; those failures reach `onError` as before.
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
  /** Workers being replaced: whatever they still answer, the restart attaches to the next one. */
  const retired = new WeakSet<PGliteViewWorkerClient>();
  /** Settles once the generation requests should use is in `current`. */
  let settled: Promise<void> = Promise.resolve();
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

  const viewWorkerClosed = () => new Error("PGlite view worker is closed.");
  const unavailable = (closedError: () => Error = viewWorkerClosed) => failed ?? closedError();
  const usable = () => !closed && failed === undefined;
  const whenCurrent = async (closedError?: () => Error) => {
    await settled;
    if (!usable()) throw unavailable(closedError);
    return current;
  };

  /**
   * Subscribes `subscription` on the current worker. A result from a worker
   * that is being replaced is ignored: the restart attaches the subscription
   * to the new worker itself. Rejects only for a failure on a worker that is
   * not being replaced, after removing the subscription. A subscription
   * made while a restart is pending is reached by both its own call and the
   * restart; whichever comes second finds it already sent and returns.
   */
  const attach = async (subscription: LiveSubscription): Promise<void> => {
    const generation = await whenCurrent();
    if (subscription.attachedTo === generation) return;
    subscription.attachedTo = generation;
    try {
      const stop = await generation.subscribe(subscription.view, subscription.params, subscription.onValue, subscription.onError);
      if (subscription.stopped || closed || retired.has(generation)) {
        void stop().catch(() => undefined);
        return;
      }
      subscription.stop = stop;
    } catch (error) {
      if (subscription.stopped || closed || retired.has(generation)) return;
      subscriptions.delete(subscription);
      throw asError(error);
    }
  };

  const start = () => {
    const generation = options.spawn();
    current = generation;
    let becameReady = false;
    void generation.ready.then(() => { becameReady = true; }, () => undefined);
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
      retired.add(generation);
      options.onRestart?.(error);
      settled = generation.close().then(() => undefined, () => undefined).then(() => {
        if (closed) return;
        try {
          start();
        } catch (failure) {
          giveUp(asError(failure));
          return;
        }
        for (const subscription of subscriptions) {
          void attach(subscription).catch((failure: Error) => subscription.onError?.(failure));
        }
      });
    });
  };
  start();

  const financial: PGliteFinancialRpcClient = Object.freeze({
    request: (async (operation, args, requestOptions) =>
      (await whenCurrent(() => new PGliteFinancialError("worker-closed"))).financial.request(operation, args, requestOptions)) as PGliteFinancialRpcClient["request"],
    close: () => {},
  });

  const operationalRequest: PGliteViewWorkerClient["operationalRequest"] = async (operation, args) =>
    (await whenCurrent(() => new PGliteOperationalError("worker-closed"))).operationalRequest(operation, args);

  return {
    get ready() {
      return whenCurrent().then((generation) => generation.ready);
    },
    operationalProvider: operationalProviderOver(operationalRequest),
    operationalRequest,
    financial,
    async subscribe(view, params, onValue, onError) {
      if (!usable()) throw unavailable();
      const subscription: LiveSubscription = { view, params, onValue, ...(onError ? { onError } : {}), stopped: false };
      subscriptions.add(subscription);
      try {
        await attach(subscription);
      } catch (error) {
        subscriptions.delete(subscription);
        throw error;
      }
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
    async close() {
      closed = true;
      detach();
      for (const subscription of subscriptions) subscription.stopped = true;
      subscriptions.clear();
      await settled;
      return current.close();
    },
  };
}
